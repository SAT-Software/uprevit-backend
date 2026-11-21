import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { GLOBAL_SEARCH_MAX_LENGTH, GLOBAL_SEARCH_MIN_LENGTH, runGlobalSearch } from '../../utils/globalSearch';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Searches the caller's workspace for active products, projects, departments and workflows.
 * @param {APIGatewayProxyEvent} event API Gateway Lambda Proxy Input Format, with `q` query parameter
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const query = event.queryStringParameters?.q?.trim() ?? '';
		if (query.length < GLOBAL_SEARCH_MIN_LENGTH || query.length > GLOBAL_SEARCH_MAX_LENGTH) {
			return ResponseWrapper.badRequest(`q must be ${GLOBAL_SEARCH_MIN_LENGTH} to ${GLOBAL_SEARCH_MAX_LENGTH} characters`);
		}

		const result = await runGlobalSearch(await getDb(), tenantResult.context.workspaceId, query);
		return ResponseWrapper.success({ message: 'Search results fetched successfully', result });
	} catch (err) {
		logError('Global search handler failed', err);
		return ResponseWrapper.internalServerError('Failed to search');
	}
});
