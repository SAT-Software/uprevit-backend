import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * Create a project
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);

		if(!auth.isValid) return auth.error;


		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
	
		const input = JSON.parse(event.body!);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');
	

		const missingFieldsResult = validateMissingFields({
			'workspace_id': input.workspace_id.toString(),
			'department_id': input.department_id.toString(),
			'project_name': input.project_name,
			'project_number': input.project_number,
			'project_description': input.project_description,
			'admin_id': input.admin_id.toString(),
		});

		if(missingFieldsResult) {
			return missingFieldsResult;
		}

		const objectIdValidation = validateAllObjectIds({
			'workspace_id': input.workspace_id,
			'department_id': input.department_id,
			'admin_id': input.admin_id,
		}, {
			'users': input.users,
		});

		if(objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();
		
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const departmentObjectId = new ObjectId(input.department_id);
		const adminObjectId = new ObjectId(input.admin_id);
		const userObjectIds = input.users ? input.users.map((userId: string) => new ObjectId(userId)) : [];

		// Check if project_number already exists
		const existingProject = await db.collection<Project>('projects').findOne({
			project_number: input.project_number,
			isArchived: { $ne: true }
		});

		if (existingProject) {
			return ResponseWrapper.conflict('Project number already exists');
		}

		const project = await db.collection<Project>('projects').insertOne({
			workspace_id: workspaceObjectId,
			department_id: departmentObjectId,
			project_name: input.project_name,
			project_number: input.project_number,
			project_description: input.project_description,
			project_manager: input.project_manager,
			admin_id: adminObjectId,
			users: userObjectIds,
			isArchived: false,
			image: input.image,
		});

		await updateAuditLog({
			entity: 'project',
			entityId: project.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Project created successfully',
			project: project,
		});
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};