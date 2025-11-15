import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Department } from '../../models/department';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * Get all departments
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) {
			return auth.error;
		}

		const db = await getDb();

		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');
		const sort = event.queryStringParameters?.sort || 'department_name';
		const workspaceId = event.queryStringParameters?.workspaceId;

		if (!workspaceId) return ResponseWrapper.badRequest('Workspace ID is required.');

		const isArchiveParam = event.queryStringParameters?.isArchive;
		let isArchive = false;

		if (isArchiveParam !== undefined) {
			isArchive = isArchiveParam.toLowerCase() === 'true';
		}

		if (limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('Limit must be between 1 and 100');
		}

		if (page < 1) {
			return ResponseWrapper.badRequest('Page must be greater than 0');
		}

		const allowedSortFields = ['department_name', 'department_description', 'manager', '_id'];
		if (!allowedSortFields.includes(sort)) {
			return ResponseWrapper.badRequest(`Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`);
		}

		const skip = (page - 1) * limit;

		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sort] = 1;

		const filter = isArchive
			? { isArchived: true, workspace_id: new ObjectId(workspaceId) }
			: { isArchived: { $ne: true }, workspace_id: new ObjectId(workspaceId) };

		const totalCount = await db.collection<Department>('departments').countDocuments(filter);

		const departments = await db
			.collection<Department>('departments')
			.find(filter)
			.sort(sortObj)
			.skip(skip)
			.limit(limit)
			.toArray();

		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
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
		});
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
