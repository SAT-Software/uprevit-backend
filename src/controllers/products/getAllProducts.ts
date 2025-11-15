import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
	   
		const auth = await authenticateRequest(event);

		if(!auth.isValid) return auth.error;


		const db = await getDb();

		// Extract query parameters for pagination and filtering
		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');
		const sort = event.queryStringParameters?.sort || 'product_name';
		const statusFilter = event.queryStringParameters?.status;
		const filterParam = event.queryStringParameters?.filter;
		const workspaceId = event.queryStringParameters?.workspaceId;

		// Validate pagination parameters
		if (limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('Limit must be between 1 and 100');
		}

		if (page < 1) {
			return ResponseWrapper.badRequest('Page must be greater than 0');
		}

		// Validate sort field
		const allowedSortFields = [
			'product_name',
			'product_plan_number',
			'product_description',
			'master_version',
			'status',
			'target_date',
			'actionAt',
			'_id',
		];
		if (!allowedSortFields.includes(sort)) {
			return ResponseWrapper.badRequest(`Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`);
		}

		const skip = (page - 1) * limit;

		// Build filter object
		const filter: any = {};

		if (workspaceId) filter.workspace_id = new ObjectId(workspaceId);
		

		if (statusFilter) {
			try {
				const statusArray = JSON.parse(statusFilter);
				if (Array.isArray(statusArray) && statusArray.length > 0) {
					filter.status = { $in: statusArray };
				}
			} catch (e) {
				// If parsing fails, treat as single status
				filter.status = statusFilter;
			}
		} else {
			// Default status filter
			filter.status = { $in: ['draft', 'submitted'] };
		}

		// General filter parameter for text search
		if (filterParam) {
			filter.$or = [
				{ product_name: { $regex: filterParam, $options: 'i' } },
				{ product_plan_number: { $regex: filterParam, $options: 'i' } },
				{ product_description: { $regex: filterParam, $options: 'i' } },
			];
		}

		// If sorting by actionAt, use aggregation to join with audit_logs
		if (sort === 'actionAt') {
			// Aggregation pipeline
			const pipeline = [
				{ $match: filter },
				{
					$lookup: {
						from: 'audit_logs',
						let: { productId: { $toString: '$_id' } },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$entityId', '$$productId'] },
											{ $eq: ['$entity', 'product'] },
											{ $eq: ['$active', true] },
										],
									},
								},
							},
							{ $sort: { actionAt: -1 } },
							{ $limit: 1 },
						],
						as: 'latestAuditLog',
					},
				},
				{
					$addFields: {
						actionAt: {
							$ifNull: [
								{ $arrayElemAt: ['$latestAuditLog.actionAt', 0] },
								new Date(0), // Default to epoch if no audit log found
							],
						},
						action: {
							$ifNull: [{ $arrayElemAt: ['$latestAuditLog.action', 0] }, null],
						},
						action_by: {
							$ifNull: [{ $arrayElemAt: ['$latestAuditLog.actionBy', 0] }, null],
						},
					},
				},
				{ $sort: { actionAt: -1 } },
				{ $skip: skip },
				{ $limit: limit },
				{
					$project: {
						_id: 1,
						product_plan_number: 1,
						product_name: 1,
						project_id: 1,
						department_id: 1,
						master_version: 1,
						status: 1,
						actionAt: 1,
						action: 1,
						action_by: 1,
						latestAuditLog: 0, // Remove the audit log data from final result
					},
				},
			];

			// Get total count for pagination
			const countPipeline = [{ $match: filter }, { $count: 'total' }];

			const [products, countResult] = await Promise.all([
				db.collection<Product>('products').aggregate(pipeline).toArray(),
				db.collection<Product>('products').aggregate(countPipeline).toArray(),
			]);

			const totalCount = countResult.length > 0 ? countResult[0].total : 0;
			const totalPages = Math.ceil(totalCount / limit);

			return ResponseWrapper.success({
				message: 'Products fetched successfully',
				result: {
					products,
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
		} else {
			// For other sort fields, use regular find with sort
			const sortObj: { [key: string]: 1 | -1 } = {};
			sortObj[sort] = 1;

			// Get total count based on filter
			const totalCount = await db.collection<Product>('products').countDocuments(filter);

			// Get paginated products based on filter
			const products = await db
				.collection<Product>('products')
				.find(filter)
				.sort(sortObj)
				.skip(skip)
				.limit(limit)
				.toArray();

			// Get audit log data for these products
			const productIds = products.map((p) => p._id!.toString());
			const auditLogs = await db
				.collection('audit_logs')
				.find({
					entityId: { $in: productIds },
					entity: 'product',
					active: true,
				})
				.sort({ actionAt: -1 })
				.toArray();

			// Create a map of productId to latest audit log
			const auditLogMap = new Map();
			auditLogs.forEach((log) => {
				if (!auditLogMap.has(log.entityId)) {
					auditLogMap.set(log.entityId, log);
				}
			});

			// Add audit log data to products
			const productsWithAudit = products.map((product) => {
				const auditLog = auditLogMap.get(product._id!.toString());
				return {
					_id: product._id,
					product_plan_number: product.product_plan_number,
					product_name: product.product_name,
					project_id: product.project_id,
					department_id: product.department_id,
					master_version: product.master_version,
					status: product.status,
					actionAt: auditLog?.actionAt || null,
					action: auditLog?.action || null,
					action_by: auditLog?.actionBy || null,
				};
			});

			const totalPages = Math.ceil(totalCount / limit);

			return ResponseWrapper.success({
				message: 'Products fetched successfully',
				result: {
					products: productsWithAudit,
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
		}
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
