import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Department } from '../../models/department';
import { ObjectId } from 'mongodb';

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
		if (!event.pathParameters?.id) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Missing required fields: id is required',
				}),
			};
		}

		const db = await getDb();

		// If ID is provided in path parameters, fetch single department (existing functionality)
		if (event.pathParameters?.id) {
			const department: Department | null = await db.collection<Department>('departments').findOne({ 
				_id: new ObjectId(event.pathParameters.id),
				isArchived: { $ne: true }
			});

			if (!department) {
				return {
					statusCode: 404,
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						message: 'Department not found',
					}),
				};
			}

			return {
				statusCode: 200,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Department fetched successfully',
					result: department,
				}),
			};
		}

		// If no ID provided, support query-based fetching with sort functionality
		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');
		const sort = event.queryStringParameters?.sort || 'department_name';
		const isArchiveParam = event.queryStringParameters?.isArchive || 'false';

		// Validate isArchive parameter
		if (isArchiveParam !== 'true' && isArchiveParam !== 'false') {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'isArchive parameter must be true or false',
				}),
			};
		}

		// Convert to boolean
		const isArchive = isArchiveParam === 'true';

		if (limit < 1 || limit > 100) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Limit must be between 1 and 100',
				}),
			};
		}

		if (page < 1) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Page must be greater than 0',
				}),
			};
		}

		const allowedSortFields = ['department_name', 'department_description', 'manager', '_id', 'actionAt'];
		if (!allowedSortFields.includes(sort)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: `Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`,
				}),
			};
		}

		const skip = (page - 1) * limit;

		const filter = isArchive ? { isArchived: true } : { isArchived: { $ne: true } };

		if (sort === 'actionAt') {
			// aggregation pipeline
			const pipeline = [
				{ $match: filter },
				{
					$lookup: {
						from: 'audit_logs',
						let: { departmentId: { $toString: '$_id' } },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$entityId', '$$departmentId'] },
											{ $eq: ['$entity', 'department'] },
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
								new Date(0), 
							],
						},
					},
				},
				{ $sort: { actionAt: -1 } },
				{ $skip: skip },
				{ $limit: limit },
				{
					$project: {
						latestAuditLog: 0, 
					},
				},
			];

			const countPipeline = [{ $match: filter }, { $count: 'total' }];

			const [departments, countResult] = await Promise.all([
				db.collection<Department>('departments').aggregate(pipeline).toArray(),
				db.collection<Department>('departments').aggregate(countPipeline).toArray(),
			]);

			const totalCount = countResult.length > 0 ? countResult[0].total : 0;
			const totalPages = Math.ceil(totalCount / limit);

			return {
				statusCode: 200,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Departments fetched successfully',
					result: {
						departments,
						pagination: {
							currentPage: page,
							totalPages,
							totalCount,
							limit,
							hasNextPage: page < totalPages,
							hasPrevPage: page > 1,
						},
					},
				}),
			};
		} else {
			const sortObj: { [key: string]: 1 | -1 } = {};
			sortObj[sort] = 1;

			const totalCount = await db.collection<Department>('departments').countDocuments(filter);

			const departments = await db
				.collection<Department>('departments')
				.find(filter)
				.sort(sortObj)
				.skip(skip)
				.limit(limit)
				.toArray();

			const totalPages = Math.ceil(totalCount / limit);

			return {
				statusCode: 200,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Departments fetched successfully',
					result: {
						departments,
						pagination: {
							currentPage: page,
							totalPages,
							totalCount,
							limit,
							hasNextPage: page < totalPages,
							hasPrevPage: page > 1,
						},
					},
				}),
			};
		}
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return {
			statusCode: 500,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Internal server error',
				error: err instanceof Error ? err.message : 'Unknown error',
				timestamp: new Date().toISOString(),
			}),
		};
	}
}; 