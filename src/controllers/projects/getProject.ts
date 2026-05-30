import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';
import { enrichProjectsWithImageUrls, enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';

type ProjectUser = {
	_id: ObjectId;
	name: string;
	email: string;
	profileAvatar?: string;
};

type ProjectWithUsers = Omit<Project, 'users'> & {
	users?: ProjectUser[];
	auditLogs?: unknown[];
	actionAt?: Date;
};

/**
 * Get a project
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const db = await getDb();

		const projectData = await db.collection<Project>('projects').aggregate<ProjectWithUsers>([
			{
				$match: {
					_id: new ObjectId(event.pathParameters.id),
					workspace_id: context.workspaceId,
					isArchived: { $ne: true },
				},
			},
			{
				$lookup: {
					from: 'users',
					localField: 'users',
					foreignField: '_id',
					pipeline: [
						{
							$project: {
								_id: 1,
								name: 1,
								email: 1,
								profileAvatar: 1,
							},
						},
					],
					as: 'users',
				},
			},
			buildLegacyAuditLookupStage({
				scopeType: 'project',
				updateActions: ['update', 'restore'],
			})
		]).toArray();

		const project = projectData[0];

		if (!project) {
			return ResponseWrapper.notFound('Project not found');
		}

		const usersWithSignedAvatars = project.users?.length
			? await enrichUsersWithProfileAvatarUrls(project.users)
			: project.users;

		const [projectWithSignedImage] = await enrichProjectsWithImageUrls([
			{
				...project,
				users: usersWithSignedAvatars,
			},
		]);

		return ResponseWrapper.success({
			message: 'Project retrieved successfully',
			project: projectWithSignedImage,
		});
	} catch (err) {
		logError('Get project handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get project');
	}
};
