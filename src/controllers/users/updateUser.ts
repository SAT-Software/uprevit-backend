import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateMissingFields } from '../../utils/validationUtils';

/**
 * Update a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Parse the request body from the event
		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: User = JSON.parse(event.body);

		// Validate required fields
		const missingFields = validateMissingFields({
			name: input.name,
			email: input.email,
		});

		if(missingFields) return missingFields;


		const db = await getDb();

		const userRecord: User | null = await db.collection<User>('users').findOne({
			email: input.email,
		});
		
		if (!userRecord) {
			return ResponseWrapper.badRequest('User not found');
		}
		
		const user = await db.collection<User>('users').updateOne({
			_id: new ObjectId((userRecord._id as ObjectId)),
		}, {
			$set: {
				name: input.name,
				profileAvatar: input.profileAvatar,
				email: input.email,
				designation: input.designation || '',
				phone: input.phone,
				location: input.location || '',
			}
		});

		const auditRecord : AuditLog = {
			entity: 'user',
			entityId: (userRecord._id as ObjectId).toString(),
			action: AuditLogAction.UPDATE,
			actionBy: (userRecord._id as ObjectId).toString(),
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'User updated successfully',
			user: user,
		});
		
	} catch (err) {
		logError('Update user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update user');
	}
};
