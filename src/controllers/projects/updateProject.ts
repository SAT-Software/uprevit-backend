import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { authenticateWithRole } from '../../utils/authUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';

/**
 * Update a project
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
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
		}, {
			'users': input.users as unknown as string[],
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
		const userObjectIds = input.users ? (input.users as unknown as string[]).map((userId: string) => new ObjectId(userId)) : [];
		const normalizedProjectImage = normalizePersistedAssetReference(input.image, projectRecord.image ?? '');

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
				users: userObjectIds,
				image: normalizedProjectImage,
			}
		});

		await recordAuditEvent({
			workspaceId: workspaceObjectId.toString(),
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
