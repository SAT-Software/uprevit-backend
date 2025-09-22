import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { type AuditLog, AuditLogAction } from '../../models/auditLog';
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
			_id: string;
			workspace_id: string;
			department_id: string;
			project_name: string;
			project_number: string;
			project_description: string;
			project_manager?: string;
			admin_id: string;
		};

		const input: ProjectUpdateInput = JSON.parse(event.body);

		if (!input._id || !input.workspace_id || !input.department_id || !input.project_name || !input.project_number || !input.project_description || !input.admin_id) {
			return ResponseWrapper.badRequest('Missing required fields: _id, workspace_id, department_id, project_name, project_number, project_description, and admin_id are required');
		}

		// Validate ObjectId formats
		if (!ObjectId.isValid(input._id)) {
			return ResponseWrapper.badRequest('Invalid _id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.workspace_id)) {
			return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.department_id)) {
			return ResponseWrapper.badRequest('Invalid department_id format. Must be a valid MongoDB ObjectId.');
		}

		if (!ObjectId.isValid(input.admin_id)) {
			return ResponseWrapper.badRequest('Invalid admin_id format. Must be a valid MongoDB ObjectId.');
		}

		const db = await getDb();

		// Check if project exists and is not archived
		const projectRecord: Project | null = await db.collection<Project>('projects').findOne({
			_id: new ObjectId(input._id),
			isArchived: { $ne: true }
		});
		
		if (!projectRecord) {
			return ResponseWrapper.notFound('Project not found or archived');
		}

		// Check if project_number already exists (excluding current project)
		const existingProject = await db.collection<Project>('projects').findOne({
			project_number: input.project_number,
			_id: { $ne: new ObjectId(input._id) },
			isArchived: { $ne: true }
		});

		if (existingProject) {
			return {
				statusCode: 409,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Project number already exists',
				}),
			};
		}
		
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const departmentObjectId = new ObjectId(input.department_id);
		const adminObjectId = new ObjectId(input.admin_id);

		const project = await db.collection<Project>('projects').updateOne({
			_id: new ObjectId(input._id),
		}, {
			$set: {
				workspace_id: workspaceObjectId,
				department_id: departmentObjectId,
				project_name: input.project_name,
				project_number: input.project_number,
				project_description: input.project_description,
				project_manager: input.project_manager,
				admin_id: adminObjectId,
			}
		});

		const auditRecord: AuditLog = {
			entity: 'project',
			entityId: input._id,
			action: AuditLogAction.UPDATE,
			actionBy: input.admin_id,
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'Project updated successfully',
			project: project,
		});
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));	
		}
};