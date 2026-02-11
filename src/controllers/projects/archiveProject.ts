import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateWithRole } from '../../utils/authUtils';
import { validateBoolean } from '../../utils/validationUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';

/**
 * Archive a project
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateWithRole(event, 'admin');

		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		if (!ObjectId.isValid(event.pathParameters.id)) {
			return ResponseWrapper.badRequest('Invalid id format. Must be a valid MongoDB ObjectId.');
		}

		const db = await getDb();

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body!);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');

		const isArchived = input.isArchived;

		const isBoolean = validateBoolean(isArchived, 'isArchived');
		if (isBoolean) return isBoolean;

		const projectRecord: Project | null = await db.collection<Project>('projects').findOne({
			_id: new ObjectId(event.pathParameters.id),
		});

		if (!projectRecord) {
			return ResponseWrapper.notFound('Project not found');
		}

		const project = await db.collection<Project>('projects').updateOne(
			{
				_id: new ObjectId(event.pathParameters.id),
			},
			{
				$set: {
					isArchived: isArchived,
				},
			},
		);

		await recordAuditEvent({
			workspaceId: projectRecord.workspace_id.toString(),
			scope: { type: 'project', id: event.pathParameters.id },
			entity: { type: 'project', id: event.pathParameters.id },
			action: isArchived ? 'archive' : 'restore',
			eventKey: isArchived ? 'project.archived' : 'project.restored',
			visibility: 'admin',
			where: { module: 'projects' },
			auth: auth.payload,
			before: { isArchived: projectRecord.isArchived },
			after: { isArchived },
			changedPaths: ['isArchived'],
			meta: {
				projectName: projectRecord.project_name,
			},
		});

		return ResponseWrapper.success({
			message: `Project ${isArchived ? 'archived' : 'restored'} successfully`,
			project: project,
		});
	} catch (err) {
		logError('Archive project handler failed', err);
		return ResponseWrapper.internalServerError('Failed to archive project');
	}
};
