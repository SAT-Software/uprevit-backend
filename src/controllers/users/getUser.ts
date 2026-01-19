import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';

/**
 * Get a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Parse the path param from the event
		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const db = await getDb();
		
		const user: User | null = await db.collection<User>('users').findOne({ _id: new ObjectId(event.pathParameters.id) });

		return ResponseWrapper.success({
			message: 'User retrieved successfully',
			user: user,
		});

	} catch (err) {
		logError('Get user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get user');
	}
};
