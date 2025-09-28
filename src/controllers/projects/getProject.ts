import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

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

		const project: Project | null = await db.collection<Project>('projects').findOne({
			_id: new ObjectId(event.pathParameters.id),
			isArchived: { $ne: true },
		});

		if (!project) {
			return ResponseWrapper.notFound('Project not found');
		}

		return ResponseWrapper.success({
			message: 'Project retrieved successfully',
			project: project,
		});
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
