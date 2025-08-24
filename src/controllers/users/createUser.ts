import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ResponseWrapper } from '../../utils/responseWrapper';

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
		// Parse the request body from the event
		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: User = JSON.parse(event.body);

		// Validate required fields
		if (!input.name || !input.email || !input.userType) {
			return ResponseWrapper.badRequest('Missing required fields: name, email, and userType are required');
		}

		const db = await getDb();
		
		const user = await db.collection<User>('users').insertOne({
			name: input.name,
			profileAvatar: input.profileAvatar,
			designation: input.designation,
			email: input.email,
			phone: input.phone,
			confirmed: input.confirmed,
			userType: input.userType,
		});

		await updateAuditLog({
			entity: 'user',
			entityId: user.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: user.insertedId.toString(),
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'User created successfully',
			user: user,
		});

	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
