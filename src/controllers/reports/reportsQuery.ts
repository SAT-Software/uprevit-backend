import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { Department } from '../../models/department';
import { Project } from '../../models/project';
import { User } from '../../models/user';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';
import { validateMissingFields, validateObjectIds } from '../../utils/validationUtils';
import { validateConditions, buildAggregationPipeline } from '../../utils/reports/queryBuilder';
import { withTelemetry } from '../../utils/telemetry';

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input;
		try {
			input = JSON.parse(event.body!);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const missingFieldsResult = validateMissingFields({
			workspaceId: input.workspaceId,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateObjectIds({ workspaceId: input.workspaceId });
		if (objectIdValidation) return objectIdValidation;

		const workspaceMismatch = assertWorkspaceMatch(
			input.workspaceId,
			context.workspaceId,
			'You are not authorized to query reports for this workspace',
		);
		if (workspaceMismatch) return workspaceMismatch;

		const page = input.pagination?.page || 1;
		const limit = Math.min(input.pagination?.limit || 10, 100);

		if (input.conditionLogic && !['AND', 'OR'].includes(input.conditionLogic)) {
			return ResponseWrapper.badRequest('conditionLogic must be either "AND" or "OR"');
		}

		if (input.conditions && input.conditions.length > 0) {
			const conditionError = validateConditions(input.conditions);
			if (conditionError) return conditionError;
		}

		const pipeline = buildAggregationPipeline(input, context.workspaceId);

		const db = await getDb();
		const result = await db.collection<Product>('products').aggregate(pipeline).toArray();

		const products = result[0]?.data || [];
		const totalCount = result[0]?.metadata?.[0]?.total || 0;
		const totalPages = Math.ceil(totalCount / limit);

		const departmentIds = [...new Set(products.map((p: any) => p.department_id).filter(Boolean))];
		const projectIds = [...new Set(products.map((p: any) => p.project_id).filter(Boolean))];
		const ownerIds = [...new Set(products.map((p: any) => p.owner_user_id).filter(Boolean))];

		const objectIdIds = (ids: any[]) => ids.map((id) => (id instanceof ObjectId ? id : ObjectId.createFromHexString(id.toString())));

		const [departments, projects, owners] = await Promise.all([
			departmentIds.length > 0
				? db.collection<Department>('departments').find({
					_id: { $in: objectIdIds(departmentIds) },
				}).project({ _id: 1, department_name: 1 }).toArray()
				: [],
			projectIds.length > 0
				? db.collection<Project>('projects').find({
					_id: { $in: objectIdIds(projectIds) },
				}).project({ _id: 1, project_name: 1 }).toArray()
				: [],
			ownerIds.length > 0
				? db.collection<User>('users').find({
					_id: { $in: objectIdIds(ownerIds) },
				}).project({ _id: 1, name: 1, email: 1 }).toArray()
				: [],
		]);

		const departmentMap = new Map(departments.map((d) => [d._id?.toString(), d.department_name]));
		const projectMap = new Map(projects.map((p) => [p._id?.toString(), p.project_name]));
		const ownerMap = new Map(owners.map((u) => [u._id?.toString(), u.name || u.email]));

		const transformedProducts = products.map((p: any) => {
			const info = p.product_information?.data ?? {};
			return {
				_id: p._id,
				product_name: p.product_name,
				product_plan_number: p.product_plan_number,
				product_description: p.product_description ?? null,
				department_id: p.department_id,
				department_name: departmentMap.get(p.department_id?.toString()) || null,
				project_id: p.project_id,
				project_name: projectMap.get(p.project_id?.toString()) || null,
				status: p.status,
				is_archived: p.is_archived === true,
				target_date: p.target_date ?? null,
				actual_completion_date: p.actual_completion_date ?? null,
				released_at: p.released_at ?? null,
				version: p.version,
				owner_name: ownerMap.get(p.owner_user_id?.toString()) || null,
				market_geography: info.market_geography || null,
				country_of_origin: info.country_of_origin || null,
				commercial_clinical: info.commercial_clinical || null,
				manufacturing_location: info.manufacturing_location || null,
				oem_contract_manufacturer: info.oem_contract_manufacturer || null,
				class_of_device: info.class_of_device || null,
				basic_udi_di: info.basic_udi_di || null,
				languages: (p.languages_information?.data ?? []).map((language: { name?: string }) => language.name).filter(Boolean),
			};
		});

		const response = {
			message: 'Query executed successfully',
			result: {
				products: transformedProducts,
				pagination: {
					total: totalCount,
					page,
					limit,
					totalPages,
				},
			},
		};

		return ResponseWrapper.success(response);
	} catch (err) {
		logError('Reports query handler failed', err);
		return ResponseWrapper.internalServerError('Failed to process reports query');
	}
});
