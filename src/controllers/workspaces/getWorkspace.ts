import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';
import { enrichWorkspaceWithLogoUrl } from '../../utils/s3-storage';

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

		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const workspaceMismatch = assertWorkspaceMatch(event.pathParameters.id, context.workspaceId);
		if (workspaceMismatch) return workspaceMismatch;

		const db = await getDb();

		const workspace: Workspace | null = await db.collection<Workspace>('workspaces').findOne({
			_id: context.workspaceId,
		});

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
