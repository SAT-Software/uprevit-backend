import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { assertWorkspaceMatch, isWorkspaceAdmin, requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';

/**
 * Update a project
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

		if (input.workspace_id) {
			const workspaceMismatch = assertWorkspaceMatch(input.workspace_id, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const objectIdValidation = validateAllObjectIds({
			'_id': input._id!,
			'department_id': input.department_id,
			'admin_id': input.admin_id,
		}, {
			'users': input.users as unknown as string[],
		});

		if (objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();
		const projectFilter = tenantObjectIdFilter(input._id!, context.workspaceId);
		const departmentObjectId = new ObjectId(input.department_id);

		const departmentInWorkspace = await db.collection('departments').findOne({
			_id: departmentObjectId,
			workspace_id: context.workspaceId,
		});

		if (!departmentInWorkspace) {
			return ResponseWrapper.badRequest('Department not found in this workspace');
		}

		const projectRecord: Project | null = await db.collection<Project>('projects').findOne({
			...projectFilter,
			isArchived: { $ne: true },
		});
		
		if (!projectRecord) {
			return ResponseWrapper.notFound('Project not found or archived');
		}

		const existingProject = await db.collection<Project>('projects').findOne({
			project_number: input.project_number,
			workspace_id: context.workspaceId,
			_id: { $ne: new ObjectId(input._id) },
			isArchived: { $ne: true },
		});

		if (existingProject) {
			return ResponseWrapper.conflict('Project number already exists');
		}
		
		const adminObjectId = new ObjectId(input.admin_id);
		const userObjectIds = input.users ? (input.users as unknown as string[]).map((userId: string) => new ObjectId(userId)) : [];
		const normalizedProjectImage = normalizePersistedAssetReference(input.image, projectRecord.image ?? '');

		const project = await db.collection<Project>('projects').updateOne(projectFilter, {
			$set: {
				department_id: departmentObjectId,
				project_name: input.project_name,
				project_number: input.project_number,
				project_description: input.project_description,
				project_manager: input.project_manager,
				admin_id: adminObjectId,
				users: userObjectIds,
				image: normalizedProjectImage,
			},
		});

		await recordAuditEvent({
			workspaceId: context.workspaceId.toString(),
			scope: { type: 'project', id: input._id!.toString() },
			entity: { type: 'project', id: input._id!.toString() },
			action: 'update',
			eventKey: 'project.updated',
			visibility: 'admin',
			where: { module: 'projects' },
			auth: auth.payload,
			before: {
				project_name: projectRecord.project_name,
				project_number: projectRecord.project_number,
				project_description: projectRecord.project_description,
				project_manager: projectRecord.project_manager,
				users: projectRecord.users?.map((user) => user.toString()) ?? [],
			},
			after: {
				project_name: input.project_name,
				project_number: input.project_number,
				project_description: input.project_description,
				project_manager: input.project_manager,
				users: (input.users as unknown as string[]) ?? [],
			},
			changedPaths: ['project_name', 'project_number', 'project_description', 'project_manager', 'users'],
			meta: {
				projectName: input.project_name,
			},
		});

		return ResponseWrapper.success({
			message: 'Project updated successfully',
			project: project,
		});
	} catch (err) {
		logError('Update project handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update project');
	}
};
