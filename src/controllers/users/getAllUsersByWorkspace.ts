import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';
import { ObjectId } from 'mongodb';

/**
 * Get all users by workspace
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.queryStringParameters?.workspaceId) {
			return ResponseWrapper.badRequest('Missing required fields: workspaceId is required');
		}
		const workspaceId = event.queryStringParameters.workspaceId;

		const db = await getDb();

		const users: User[] = await db.collection<User>('users').find({ workspaceId: new ObjectId(workspaceId) }).toArray();

		return ResponseWrapper.success({
			message: 'Users retrieved successfully',
			data: users,
		});

	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};