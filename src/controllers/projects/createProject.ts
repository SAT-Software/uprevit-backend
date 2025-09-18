import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Project } from '../../models/project';
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

		type ProjectInput = {
			name: string;
			description: string;
			department_id: string;
			workspace_id: string;
			manager?: string;
			admin_id: string;
			user_ids?: string[];
		};

		const input: ProjectInput = JSON.parse(event.body);

		if (!input.name || !input.description || !input.department_id || !input.workspace_id || !input.admin_id) {
			return ResponseWrapper.badRequest('Missing required fields: name, description, department_id, workspace_id, and admin_id are required');
		}

		// Validate ObjectId formats
		if (!ObjectId.isValid(input.workspace_id)) {
			return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.department_id)) {
			return ResponseWrapper.badRequest('Invalid department_id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.admin_id)) {
			return ResponseWrapper.badRequest('Invalid admin_id format. Must be a valid MongoDB ObjectId.');
		}

		// Validate user IDs if provided
		if (input.user_ids && input.user_ids.length > 0) {
			const invalidUserIds = input.user_ids.filter(userId => !ObjectId.isValid(userId));
			if (invalidUserIds.length > 0) {
				return ResponseWrapper.badRequest(`Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`);
			}
		}

		const db = await getDb();

		const workspaceObjectId = new ObjectId(input.workspace_id);
		const departmentObjectId = new ObjectId(input.department_id);
		const adminObjectId = new ObjectId(input.admin_id);
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

		const project = await db.collection<Project>('projects').insertOne({
			workspace_id: workspaceObjectId,
			department_id: departmentObjectId,
			project_name: input.name,
			project_description: input.description,
			manager: input.manager,
			admin_id: adminObjectId,
			users: userObjectIds,
			isArchived: false,
		});

		await updateAuditLog({
			entity: 'project',
			entityId: project.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: input.admin_id,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Project created successfully',
			project: {
				_id: project.insertedId.toString(),
				name: input.name,
				description: input.description,
				department_id: input.department_id,
				workspace_id: input.workspace_id,
				manager: input.manager,
				admin_id: input.admin_id,
				users: userObjects,
				isArchived: false
			}
		});
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};