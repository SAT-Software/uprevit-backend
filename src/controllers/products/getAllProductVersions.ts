import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { productLineageFilter } from '../../utils/productLifecycle';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';

/**
 * Get all versions of a product
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const productId = event.queryStringParameters?.id;
		const workspaceId = event.queryStringParameters?.workspaceId;
		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');

		if (!productId) {
			return ResponseWrapper.badRequest("Product id - 'id' is required in query parameters");
		}

		if (workspaceId) {
			const workspaceMismatch = assertWorkspaceMatch(workspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		if (limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('Limit must be between 1 and 100');
		}

		if (page < 1) {
			return ResponseWrapper.badRequest('Page must be greater than 0');
		}

		const validationResult = validateAllObjectIds({ '_id': productId });
		if (validationResult) return validationResult;

		const db = await getDb();
		const skip = (page - 1) * limit;

		const product = await db.collection<Product>('products').findOne(
			tenantObjectIdFilter(productId, context.workspaceId),
		);

		if (!product) {
			return ResponseWrapper.notFound('Product not found');
		}

		const matchFilter = productLineageFilter(product);

		const pipeline: any[] = [
			{ $match: matchFilter },
			buildLegacyAuditLookupStage({
				scopeType: 'product',
				updateActions: ['update', 'submit', 'delete', 'move', 'link', 'unlink', 'restore'],
			}),
			{ $sort: { version: -1 } },
			{ $skip: skip },
			{ $limit: limit },
			{ $lookup: { from: 'workflows', localField: 'released_by_workflow_id', foreignField: '_id', as: 'released_by_workflow', pipeline: [{ $project: { _id: 0, id: '$_id', numberLabel: 1 } }] } },
			{ $addFields: { released_by_workflow: { $ifNull: [{ $first: '$released_by_workflow' }, null] } } },
		];

		const countPipeline = [{ $match: matchFilter }, { $count: 'total' }];

		const [versions, countResult] = await Promise.all([
			db.collection<Product>('products').aggregate(pipeline).toArray(),
			db.collection<Product>('products').aggregate(countPipeline).toArray(),
		]);

		const totalCount = countResult.length > 0 ? countResult[0].total : 0;
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Product versions fetched successfully',
			result: {
				product_plan_number: product.product_plan_number,
				product_name: product.product_name,
				versions,
				pagination: {
					currentPage: page,
					totalPages,
					totalCount,
					limit,
					hasNextPage: page < totalPages,
					hasPrevPage: page > 1,
				},
			},
		});
	} catch (err) {
		logError('Get all product versions handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get product versions');
	}
};
