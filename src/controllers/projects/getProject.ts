import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';

/**
 * Get a project
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const db = await getDb();

		const projectData = await db.collection<Project>('projects').aggregate([
			{
				$match: {
					_id: new ObjectId(event.pathParameters.id),
					isArchived: { $ne: true }
				}
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

		return ResponseWrapper.success({
			message: 'Project retrieved successfully',
			project: project,
		});
	} catch (err) {
		logError('Get project handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get project');
	}
};
