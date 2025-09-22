import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { verifyJWT } from '../../utils/authUtils';

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
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const authHeader = event.headers?.Authorization || event.headers?.authorization;
		if(!authHeader) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const token = authHeader.split(' ')[1];

		const { isValid, payload } = await verifyJWT(token);
		
		if(!isValid) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const db = await getDb();
		
		const department: Department | null = await db.collection<Department>('departments').findOne({ 
			_id: new ObjectId(event.pathParameters.id),
			isArchived: { $ne: true }
		});

		if (!department) {
			return ResponseWrapper.badRequest('Department not found');
		}

		return ResponseWrapper.success({
			message: 'Department retrieved successfully',
			department: department,
		});
		
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
}; 