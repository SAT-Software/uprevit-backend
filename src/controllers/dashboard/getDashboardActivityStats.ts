import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { getDashboardActivityStats } from '../../utils/dashboardActivityStats';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';

/**
 * API endpoint to get 30-day dashboard activity statistics for a workspace.
 *
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} Activity breakdowns for departments, projects, products, source files, and archives
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const requestedWorkspaceId = event.queryStringParameters?.id;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspace id');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const db = await getDb();
		const activityStats = await getDashboardActivityStats(db, context.workspaceId);

		return ResponseWrapper.success({
			message: 'Dashboard activity statistics retrieved successfully',
			data: activityStats,
		});
	} catch (err) {
		logError('Get dashboard activity stats handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get dashboard activity stats');
	}
};
