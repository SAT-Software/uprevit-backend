import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
import { enrichWorkspaceWithLogoUrl } from '../../utils/mediaAssetUrls';

/**
 * API endpoint to get a workspace by id
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const auth = await authenticateRequest(event);
		
		if(!auth.isValid) {
			return auth.error;
		}

		const db = await getDb();
		
		const workspace: Workspace | null = await db.collection<Workspace>('workspaces').findOne({ _id: new ObjectId(event.pathParameters.id) });

		if (!workspace) {
			return ResponseWrapper.notFound('Workspace not found');
		}

		const workspaceWithSignedLogo = await enrichWorkspaceWithLogoUrl(workspace);

		return ResponseWrapper.success({
			message: 'Workspace retrieved successfully',
			workspace: workspaceWithSignedLogo,
		});
		
	} catch (err) {
		logError('Get workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get workspace');
	}
}; 
