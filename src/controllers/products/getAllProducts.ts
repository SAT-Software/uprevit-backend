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

		const pipeline: any[] = [
			{ $match: filter },
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
			{
				$lookup: {
					from: 'departments',
					localField: 'department_id',
					foreignField: '_id',
					as: 'department',
					pipeline: [
						{ 
							$project: { department_name: 1 }
						}
					]
				}
			},
			{
				$lookup: {
					from: 'projects',
					localField: 'project_id',
					foreignField: '_id',
					as: 'project',
					pipeline: [
						{ 
							$project: { project_name: 1 }
						}
					]
				}
			}
		];

		// Add sorting based on the sort parameter
		if (sort === 'actionAt') {
			// Sort by the first audit log's actionAt
			pipeline.push({ $sort: { 'auditLogs.0.actionAt': -1 } });
		} else {
			// Sort by the specified field
			const sortObj: { [key: string]: 1 | -1 } = {};
			sortObj[sort] = 1;
			pipeline.push({ $sort: sortObj });
		}

		// Add pagination
		pipeline.push({ $skip: skip });
		pipeline.push({ $limit: limit });

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
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
