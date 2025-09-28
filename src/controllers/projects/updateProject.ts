import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { type AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { authenticateRequest } from '../../utils/authUtils';

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
		const auth = await authenticateRequest(event);
		
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		let input: Omit<Project, 'isArchived'>;
		
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
			'_id': input._id!.toString(),
		});

		if (missingFieldsResult) {
			return missingFieldsResult;
		}

		const objectIdValidation = validateAllObjectIds({
			'_id': input._id!,
			'workspace_id': input.workspace_id,
			'department_id': input.department_id,
			'admin_id': input.admin_id,
		});

		if (objectIdValidation) {
			return objectIdValidation;
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
			return ResponseWrapper.conflict('Project number already exists');
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
			entityId: input._id!.toString(),
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
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