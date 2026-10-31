import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getAnalytics, parseAnalyticsFilters } from '../../utils/analytics';
import { getDb } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { requireTenantContext } from '../../utils/tenantContext';

/**
 * API endpoint to get workspace analytics: pipeline, deadlines, throughput, approvals and blockers.
 *
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} Analytics for the requested date range, department and project
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const parsed = parseAnalyticsFilters(tenantResult.context.workspaceId, event.queryStringParameters);
		if ('error' in parsed) return ResponseWrapper.badRequest(parsed.error);

		const db = await getDb();
		return ResponseWrapper.success({
			message: 'Analytics retrieved successfully',
			data: await getAnalytics(db, parsed.filters),
		});
	} catch (err) {
		logError('Get analytics handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get analytics');
	}
};
