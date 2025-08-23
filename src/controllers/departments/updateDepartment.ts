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

		type DepartmentUpdateInput = {
			_id: string;
			department_name: string;
			department_description: string;
			image?: string;
			manager?: string;
			admin_id: string;
			workspace_id: string;
			users?: string[];
		};

		const input: DepartmentUpdateInput = JSON.parse(event.body);

		if (!input.department_name || !input.department_description || !input.admin_id || !input.workspace_id || !input._id) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Missing required fields: _id, department_name, department_description, admin_id, and workspace_id are required',
				}),
			};
		}

		// Validate ObjectId formats
		if (!ObjectId.isValid(input._id)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Invalid _id format. Must be a valid MongoDB ObjectId.',
				}),
			};
		}

		if (!ObjectId.isValid(input.admin_id)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Invalid admin_id format. Must be a valid MongoDB ObjectId.',
				}),
			};
		}

		if (!ObjectId.isValid(input.workspace_id)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Invalid workspace_id format. Must be a valid MongoDB ObjectId.',
				}),
			};
		}

		// Validate user IDs if provided
		if (input.users && input.users.length > 0) {
			const invalidUserIds = input.users.filter(userId => !ObjectId.isValid(userId));
			if (invalidUserIds.length > 0) {
				return {
					statusCode: 400,
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						message: `Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`,
					}),
				};
			}
		}

		const db = await getDb();

		const departmentRecord: Department | null = await db.collection<Department>('departments').findOne({
			_id: new ObjectId(input._id),
			isArchived: { $ne: true }
		});
		
		if (!departmentRecord) {
			return {
				statusCode: 404,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Department not found or archived',
				}),
			};
		}
		
		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const userObjectIds = input.users ? input.users.map(userId => new ObjectId(userId)) : [];

		const department = await db.collection<Department>('departments').updateOne({
			_id: new ObjectId((departmentRecord._id as ObjectId)),
		}, {
			$set: {
				department_name: input.department_name,
				department_description: input.department_description,
				image: input.image,
				manager: input.manager,
				admin_id: adminObjectId,
				workspace_id: workspaceObjectId,
				users: userObjectIds,
			}
		});

		const auditRecord : AuditLog = {
			entity: 'department',
			entityId: (departmentRecord._id as ObjectId).toString(),
			action: AuditLogAction.UPDATE,
			actionBy: input.admin_id,
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
				message: 'Department updated successfully',
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