import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { assertWorkspaceMatch, isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';

/**
 * Create a project
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
	
		const input = JSON.parse(event.body!);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');
	

		const missingFieldsResult = validateMissingFields({
			'department_id': input.department_id.toString(),
			'project_name': input.project_name,
			'project_number': input.project_number,
			'project_description': input.project_description,
			'admin_id': input.admin_id.toString(),
		});

		if(missingFieldsResult) {
			return missingFieldsResult;
		}

		if (input.workspace_id) {
			const workspaceMismatch = assertWorkspaceMatch(input.workspace_id, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const objectIdValidation = validateAllObjectIds({
			'department_id': input.department_id,
			'admin_id': input.admin_id,
		}, {
			'users': input.users,
		});

		if(objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();
		
		const workspaceObjectId = context.workspaceId;
		const departmentObjectId = new ObjectId(input.department_id);
		const adminObjectId = new ObjectId(input.admin_id);
		const userObjectIds = input.users ? input.users.map((userId: string) => new ObjectId(userId)) : [];
		const normalizedProjectImage = normalizePersistedAssetReference(input.image, '');

		const departmentInWorkspace = await db.collection('departments').findOne({
			_id: departmentObjectId,
			workspace_id: workspaceObjectId,
		});

		if (!departmentInWorkspace) {
			return ResponseWrapper.badRequest('Department not found in this workspace');
		}

		const existingProject = await db.collection<Project>('projects').findOne({
			project_number: input.project_number,
			workspace_id: workspaceObjectId,
			isArchived: { $ne: true },
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
			image: normalizedProjectImage,
		});

		await recordAuditEvent({
			workspaceId: workspaceObjectId.toString(),
			scope: { type: 'project', id: project.insertedId.toString() },
			entity: { type: 'project', id: project.insertedId.toString() },
			action: 'create',
			eventKey: 'project.created',
			visibility: 'admin',
			where: { module: 'projects' },
			auth: auth.payload,
			after: {
				project_name: input.project_name,
				project_number: input.project_number,
				project_description: input.project_description,
				project_manager: input.project_manager,
			},
			changedPaths: ['project_name', 'project_number', 'project_description', 'project_manager'],
			meta: {
				projectName: input.project_name,
			},
		});

		await recordCommittedUploadIfNew({
			workspaceId: workspaceObjectId,
			previousKey: '',
			newKey: normalizedProjectImage,
			sizeBytes: input.imageSizeBytes ?? input.sizeBytes,
			metadata: { assetType: 'project_image' },
		});

		return ResponseWrapper.created({
			message: 'Project created successfully',
			project: project,
		});
	} catch (err) {
		logError('Create project handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create project');
	}
};
