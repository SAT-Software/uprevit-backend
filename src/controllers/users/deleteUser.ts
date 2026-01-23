import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';

/**
 * Delete a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Parse the id from the event
		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('User ID is required');
		}

		const db = await getDb();
		
		const user = await db.collection<User>('users').deleteOne({
			_id: new ObjectId(event.pathParameters?.id)
		});

		const auditRecord : AuditLog = {
			entity: 'user',
			entityId: (event.pathParameters?.id).toString(),
			action: AuditLogAction.DELETE,
			actionBy: (event.pathParameters?.id).toString(),
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'User deleted successfully',
			user: user,
		});

	} catch (err) {
		logError('Delete user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to delete user');
	}
};
