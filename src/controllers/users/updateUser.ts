import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
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
		// Parse the request body from the event
		if (!event.body) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Request body is required',
				}),
			};
		}

		const input: User = JSON.parse(event.body);

		// Validate required fields
		if (!input.name || !input.email || !input.userType) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Missing required fields: name, email, and userType are required',
				}),
			};
		}

		const db = await getDb();

		const userRecord: User | null = await db.collection<User>('users').findOne({
			email: input.email,
		});
		
		if (!userRecord) {
			return {
				statusCode: 404,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'User not found',
				}),
			};
		}
		
		const user = await db.collection<User>('users').updateOne({
			_id: new ObjectId((userRecord._id as ObjectId)),
		}, {
			$set: {
				name: input.name,
				profileAvatar: input.profileAvatar,
				designation: input.designation,
				email: input.email,
				phone: input.phone,
				confirmed: input.confirmed,
				userType: input.userType,
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

		return {
			statusCode: 200,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'User updated successfully',
				user: user,
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
