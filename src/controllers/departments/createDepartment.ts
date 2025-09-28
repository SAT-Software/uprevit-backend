import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateWithRole, validateRole } from '../../utils/authUtils';

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

		const auth = await authenticateWithRole(event, 'admin');
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: Department = JSON.parse(event.body);

		if (!input.department_name || !input.department_description || !input.admin_id || !input.workspace_id) {
			return ResponseWrapper.badRequest('Missing required fields: department_name, department_description, admin_id, and workspace_id are required');
		}

		// Validate ObjectId formats
		if (!ObjectId.isValid(input.admin_id)) {
			return ResponseWrapper.badRequest('Invalid admin_id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.workspace_id)) {
			return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
		}

		// Validate user IDs if provided
		if (input.users && input.users.length > 0) {
			const invalidUserIds = input.users.filter(userId => !ObjectId.isValid(userId));
			if (invalidUserIds.length > 0) {
				return ResponseWrapper.badRequest(`Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`);
			}
		}

		const db = await getDb();
		
		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const userObjectIds = input.users ? input.users.map(userId => new ObjectId(userId)) : [];

		const department = await db.collection<Department>('departments').insertOne({
			department_name: input.department_name,
			department_description: input.department_description,
			image: input.image,
			manager: input.manager,
			admin_id: adminObjectId,
			workspace_id: workspaceObjectId,
			users: userObjectIds,
			isArchived: false,
		});

		await updateAuditLog({
			entity: 'department',
			entityId: department.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Department created successfully',
			department: department,
		});

	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
}; 