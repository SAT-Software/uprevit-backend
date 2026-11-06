import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { MongoBulkWriteError, ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import type { Project } from '../../models/project';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';
import {
	acquireImportLock,
	buildImportedProduct,
	findWorkspacePlanNumbers,
	type ImportProductInput,
	MAX_IMPORT_PRODUCTS,
	nameKey,
	releaseImportLock,
	validateImportProduct,
} from '../../utils/productImport';

type ImportResult = { plan_number: string; status: 'created' | 'failed'; product_id?: string; error?: string };
/**
 * Creates Draft products from an import file in existing projects
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;
		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Insufficient permissions');

		const input = JSON.parse(event.body || '{}');
		const products: ImportProductInput[] = input?.products;
		if (!Array.isArray(products) || !products.length) return ResponseWrapper.badRequest('products must be a non-empty list');
		if (products.length > MAX_IMPORT_PRODUCTS) {
			return ResponseWrapper.badRequest(`Send at most ${MAX_IMPORT_PRODUCTS} products per request`);
		}

		const db = await getDb();
		const { workspaceId, userId } = context;
		if (!(await acquireImportLock(db, workspaceId))) {
			return ResponseWrapper.conflict('Another product import is running in this workspace. Try again in a moment.');
		}

		try {
			const results: ImportResult[] = products.map((product) => ({
				plan_number: typeof product?.product_plan_number === 'string' ? product.product_plan_number.trim() : '',
				status: 'failed',
			}));
			const fail = (index: number, error: string) => { results[index].error = error; };

			const usedPlanNumbers = await findWorkspacePlanNumbers(db, workspaceId);
			products.forEach((product, index) => {
				const error = validateImportProduct(product);
				if (error) return fail(index, error);
				const key = nameKey(product.product_plan_number);
				if (usedPlanNumbers.has(key)) return fail(index, 'A product with this plan number already exists in this workspace');
				usedPlanNumbers.add(key);
			});

			const projectIds = [...new Set(products.filter((_, index) => !results[index].error).map((product) => product.project_id))];
			const existingProjects = projectIds.length ? await db.collection<Project>('projects').find({
				_id: { $in: projectIds.map((id) => new ObjectId(id)) },
				workspace_id: workspaceId,
				isArchived: { $ne: true },
			}).toArray() : [];
			const projectsById = new Map(existingProjects.map((project) => [project._id!.toString(), project]));

			const documents: Array<{ index: number; product: Product }> = [];
			for (const [index, product] of products.entries()) {
				if (results[index].error) continue;
				const project = projectsById.get(product.project_id);
				if (!project) {
					fail(index, 'The assigned project no longer exists or is archived');
					continue;
				}
				documents.push({
					index,
					product: buildImportedProduct(product, {
						workspaceId,
						projectId: project._id!,
						departmentId: project.department_id,
						ownerId: userId,
					}),
				});
			}

			const failedInserts = new Set<number>();
			if (documents.length) {
				try {
					await db.collection<Product>('products').insertMany(documents.map((item) => item.product), { ordered: false });
				} catch (error) {
					if (!(error instanceof MongoBulkWriteError)) throw error;
					const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
					writeErrors.forEach((writeError) => failedInserts.add(writeError.index));
				}
			}

			for (const [position, { index, product }] of documents.entries()) {
				if (failedInserts.has(position)) {
					fail(index, 'The product could not be created');
					continue;
				}
				const productId = product._id!.toString();
				Object.assign(results[index], { status: 'created', product_id: productId });
				await recordAuditEvent({
					workspaceId: workspaceId.toString(),
					scope: { type: 'product', id: productId },
					entity: { type: 'product', id: productId },
					action: 'create',
					eventKey: 'product.created',
					visibility: 'all',
					where: { module: 'products' },
					auth: auth.payload,
					after: {
						product_plan_number: product.product_plan_number,
						product_name: product.product_name,
						product_description: product.product_description,
						status: product.status,
						version: product.version,
					},
					changedPaths: ['product_plan_number', 'product_name', 'product_description', 'status', 'version'],
					meta: { productName: product.product_name, source: 'product_import' },
				});
			}

			return ResponseWrapper.success({ results });
		} finally {
			await releaseImportLock(db, workspaceId);
		}
	} catch (err) {
		logError('Import products handler failed', err);
		return ResponseWrapper.internalServerError('Failed to import products');
	}
});
