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

		type ProjectUpdateInput = {
			name?: string;
			description?: string;
			department_id?: string;
			workspace_id?: string;
			manager?: string;
			admin_id?: string;
			user_ids?: string[];
		};

		const input: ProjectUpdateInput = JSON.parse(event.body);

		// Get project ID from path parameters
		const projectId = event.pathParameters?.id;
		if (!projectId) {
			return ResponseWrapper.badRequest('Project ID is required in path parameters');
		}

		// Validate project ID format
		if (!ObjectId.isValid(projectId)) {
			return ResponseWrapper.badRequest('Invalid project ID format. Must be a valid MongoDB ObjectId.');
		}

		// Validate ObjectId formats for optional fields
		if (input.workspace_id && !ObjectId.isValid(input.workspace_id)) {
			return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
		}

		if (input.department_id && !ObjectId.isValid(input.department_id)) {
			return ResponseWrapper.badRequest('Invalid department_id format. Must be a valid MongoDB ObjectId.');
		}

		if (input.admin_id && !ObjectId.isValid(input.admin_id)) {
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

		// Check if project exists and is not archived
		const projectRecord: Project | null = await db.collection<Project>('projects').findOne({
			_id: new ObjectId(projectId),
			isArchived: { $ne: true }
		});

		if (!projectRecord) {
			return ResponseWrapper.notFound('Project not found or archived');
		}

		// Build update object with only provided fields
		const updateFields: any = {};
		if (input.name !== undefined) updateFields.project_name = input.name;
		if (input.description !== undefined) updateFields.project_description = input.description;
		if (input.department_id !== undefined) updateFields.department_id = new ObjectId(input.department_id);
		if (input.workspace_id !== undefined) updateFields.workspace_id = new ObjectId(input.workspace_id);
		if (input.manager !== undefined) updateFields.manager = input.manager;
		if (input.admin_id !== undefined) updateFields.admin_id = new ObjectId(input.admin_id);

		// Handle user_ids - fetch user details if provided
		let userObjects: any[] = [];
		if (input.user_ids !== undefined) {
			const userObjectIds = input.user_ids.map(userId => new ObjectId(userId));
			updateFields.users = userObjectIds;

			if (input.user_ids.length > 0) {
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
		}

		const project = await db.collection<Project>('projects').updateOne({
			_id: new ObjectId(projectId),
		}, {
			$set: updateFields,
		});

		const auditRecord: AuditLog = {
			entity: 'project',
			entityId: projectId,
			action: AuditLogAction.UPDATE,
			actionBy: input.admin_id || projectRecord.admin_id.toString(),
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		// Get updated project record for response
		const updatedProject = await db.collection<Project>('projects').findOne({
			_id: new ObjectId(projectId),
		});

		return ResponseWrapper.success({
			message: 'Project updated successfully',
			project: {
				_id: projectId,
				name: updatedProject?.project_name,
				description: updatedProject?.project_description,
				department_id: updatedProject?.department_id.toString(),
				workspace_id: updatedProject?.workspace_id.toString(),
				manager: updatedProject?.manager,
				admin_id: updatedProject?.admin_id.toString(),
				users: input.user_ids !== undefined ? userObjects : undefined,
				isArchived: updatedProject?.isArchived
			}
		});
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};