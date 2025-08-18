import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Department } from '../../models/department';
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
		
		const departmentRecord: Department | null = await db.collection<Department>('departments').findOne({
			_id: new ObjectId(event.pathParameters.id)
		});

		if (!departmentRecord) {
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

		const department = await db.collection<Department>('departments').deleteOne({
			_id: new ObjectId(event.pathParameters?.id)
		});

		const auditRecord : AuditLog = {
			entity: 'department',
			entityId: (event.pathParameters?.id).toString(),
			action: AuditLogAction.DELETE,
			actionBy: (departmentRecord.admin_id as ObjectId).toString(),
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
				message: 'Department deleted successfully',
				department: department,
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