import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Department } from '../../models/department';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
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
		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		type DepartmentInput = {
			name: string;
			description: string;
			image?: string;
			manager?: string;
			admin_id: string;
			workspace_id: string;
			user_ids?: string[];
		};

		const input: DepartmentInput = JSON.parse(event.body);

		if (!input.name || !input.description || !input.admin_id || !input.workspace_id) {
			return ResponseWrapper.badRequest('Missing required fields: name, description, admin_id, and workspace_id are required');
		}

		// Validate ObjectId formats
		if (!ObjectId.isValid(input.admin_id)) {
			return ResponseWrapper.badRequest('Invalid admin_id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.workspace_id)) {
			return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
		}

		// Validate user IDs if provided
		if (input.user_ids && input.user_ids.length > 0) {
			const invalidUserIds = input.user_ids.filter(userId => !ObjectId.isValid(userId));
			if (invalidUserIds.length > 0) {
				return ResponseWrapper.badRequest(`Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`);
			}
		}

		const db = await getDb();

		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const userObjectIds = input.user_ids ? input.user_ids.map(userId => new ObjectId(userId)) : [];

		// Fetch user details if user_ids are provided
		let userObjects: any[] = [];
		if (input.user_ids && input.user_ids.length > 0) {
			const users = await db.collection('users')
				.find({
					_id: { $in: userObjectIds }
				})
				.project({
					_id: 1,
					name: 1,
					profileAvatar: 1,
					designation: 1
				})
				.toArray();

			userObjects = users.map(user => ({
				_id: user._id.toString(),
				name: user.name,
				profileAvatar: user.profileAvatar,
				designation: user.designation
			}));
		}

		const department = await db.collection<Department>('departments').insertOne({
			department_name: input.name,
			department_description: input.description,
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
			actionBy: input.workspace_id,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Department created successfully',
			department: {
				_id: department.insertedId.toString(),
				name: input.name,
				description: input.description,
				image: input.image,
				manager: input.manager,
				admin_id: input.admin_id,
				workspace_id: input.workspace_id,
				users: userObjects,
				isArchived: false
			}
		});

	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
}; 