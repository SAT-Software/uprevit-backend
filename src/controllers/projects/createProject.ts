import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateRole } from '../../utils/authUtils';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';

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

		const authHeader = event.headers?.Authorization || event.headers?.authorization;
		if(!authHeader) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const token = authHeader.split(' ')[1];
		const { isValid, payload } = await validateRole(token, 'admin');
		if(!isValid) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		let input: Project;

		try {
			input = JSON.parse(event.body!);
		} catch (error) {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

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
		});

		if(objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();
		
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const departmentObjectId = new ObjectId(input.department_id);
		const adminObjectId = new ObjectId(input.admin_id);

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
			isArchived: false,
		});

		await updateAuditLog({
			entity: 'project',
			entityId: project.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: payload?.name?.toString()!,
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