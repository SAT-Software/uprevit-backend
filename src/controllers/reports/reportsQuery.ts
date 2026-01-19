import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { Department } from '../../models/department';
import { Project } from '../../models/project';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';
import { validateMissingFields, validateObjectIds } from '../../utils/validationUtils';
import { validateConditions, buildAggregationPipeline } from '../../utils/reports/queryBuilder';

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

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

		const page = input.pagination?.page || 1;
		const limit = Math.min(input.pagination?.limit || 10, 100);

		if (input.conditionLogic && !['AND', 'OR'].includes(input.conditionLogic)) {
			return ResponseWrapper.badRequest('conditionLogic must be either "AND" or "OR"');
		}

		if (input.conditions && input.conditions.length > 0) {
			const conditionError = validateConditions(input.conditions);
			if (conditionError) return conditionError;
		}

		const workspaceId = ObjectId.createFromHexString(input.workspaceId);
		const pipeline = buildAggregationPipeline(input, workspaceId);

		const db = await getDb();
		const result = await db.collection<Product>('products').aggregate(pipeline).toArray();

		const products = result[0]?.data || [];
		const totalCount = result[0]?.metadata?.[0]?.total || 0;
		const totalPages = Math.ceil(totalCount / limit);

		const departmentIds = [...new Set(products.map((p: any) => p.department_id).filter(Boolean))];
		const projectIds = [...new Set(products.map((p: any) => p.project_id).filter(Boolean))];

		const objectIdIds = (ids: any[]) => ids.map((id) => (id instanceof ObjectId ? id : ObjectId.createFromHexString(id.toString())));

		const [departments, projects] = await Promise.all([
			departmentIds.length > 0
				? await db.collection<Department>('departments').find({
					_id: { $in: objectIdIds(departmentIds) },
				}).project({ _id: 1, department_name: 1 }).toArray()
				: [],

			projectIds.length > 0
				? await db.collection<Project>('projects').find({
					_id: { $in: objectIdIds(projectIds) },
				}).project({ _id: 1, project_name: 1 }).toArray()
				: [],	
		]);

		const departmentMap = new Map(departments.map((d) => [d._id?.toString(), d.department_name]));
		const projectMap = new Map(projects.map((p) => [p._id?.toString(), p.project_name]));

		const transformedProducts = products.map((p: any) => ({
			_id: p._id,
			product_name: p.product_name,
			product_plan_number: p.product_plan_number,
			department_id: p.department_id,
			department_name: departmentMap.get(p.department_id?.toString()) || null,
			project_id: p.project_id,
			project_name: projectMap.get(p.project_id?.toString()) || null,
			status: p.status,
			target_date: p.target_date,
			version: p.version,
		}));

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
		console.error('Reports query handler failed');
		return ResponseWrapper.internalServerError('Failed to process reports query');
	}
};
