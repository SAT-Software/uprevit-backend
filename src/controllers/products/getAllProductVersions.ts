import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';
import { validateAllObjectIds } from '../../utils/validationUtils';

/**
 * Get all versions of a product
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const productId = event.queryStringParameters?.id;
		const workspaceId = event.queryStringParameters?.workspaceId;
		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');

		if (!productId) {
			return ResponseWrapper.badRequest("Product id - 'id' is required in query parameters");
		}

		if (!workspaceId) {
			return ResponseWrapper.badRequest("Workspace id - 'workspaceId' is required in query parameters");
		}

		if (limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('Limit must be between 1 and 100');
		}

		if (page < 1) {
			return ResponseWrapper.badRequest('Page must be greater than 0');
		}

		const validationResult = validateAllObjectIds({ '_id': productId, 'workspaceId': workspaceId });
		if (validationResult) return validationResult;

		const db = await getDb();
		const productObjectId = new ObjectId(productId);
		const workspaceObjectId = new ObjectId(workspaceId);
		const skip = (page - 1) * limit;

		// First, find the product to get its product_plan_number
		const product = await db.collection<Product>('products').findOne({ _id: productObjectId });

		if (!product) {
			return ResponseWrapper.notFound('Product not found');
		}

		const matchFilter = { 
			product_plan_number: product.product_plan_number,
			workspace_id: workspaceObjectId 
		};

		// Find all versions with the same product_plan_number, sorted by version descending
		const pipeline: any[] = [
			{ $match: matchFilter },
			{
				$lookup: {
					from: 'audit_log',
					let: { productIdString: { $toString: '$_id' } },
					pipeline: [
						{
							$match: {
								$expr: {
									$and: [
										{ $eq: ['$entity', 'product'] },
										{ $eq: ['$entityId', '$$productIdString'] },
										{ $in: ['$action', ['create', 'update']] },
										{ $eq: ['$active', true] }
									]
								}
							}
						},
						{ $sort: { actionAt: -1 } },
						{
							$project: {
								entity: 1,
								entityId: 1,
								action: 1,
								actionBy: 1,
								actionAt: 1,
								active: 1
							}
						},
						{ $limit: 2 }
					],
					as: 'auditLogs'
				}
			},
			{ $sort: { version: -1 } },
			{ $skip: skip },
			{ $limit: limit }
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
		console.error('Get all product versions handler failed');
		return ResponseWrapper.internalServerError('Failed to get product versions');
	}
};
