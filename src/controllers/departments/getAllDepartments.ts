import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Department } from '../../models/department';

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
		const db = await getDb();

		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');
		const sort = event.queryStringParameters?.sort || 'department_name';
		// Parse isArchive parameter to boolean
		const isArchiveParam = event.queryStringParameters?.isArchive;
		let isArchive = false; // default value
		
		if (isArchiveParam !== undefined) {
			if (isArchiveParam === 'true') {
				isArchive = true;
			} else if (isArchiveParam === 'false') {
				isArchive = false;
			} else {
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
		}

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

		const allowedSortFields = ['department_name', 'department_description', 'manager', '_id'];
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

		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sort] = 1;

		// filter based on isArchive parameter
		const filter = isArchive ? { isArchived: true } : { isArchived: { $ne: true } };

		const totalCount = await db.collection<Department>('departments').countDocuments(filter);

		const departments = await db.collection<Department>('departments')
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