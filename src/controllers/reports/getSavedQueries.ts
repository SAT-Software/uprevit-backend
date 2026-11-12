import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SAVED_QUERY_KINDS } from '../../models/savedQuery';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import {
	MAX_SAVED_QUERIES_PER_USER,
	getSavedQueriesCollection,
	isSavedQueryKind,
	savedQueryListFilters,
	toSavedQueryResponse,
} from '../../utils/savedQueries';
import { withTelemetry } from '../../utils/telemetry';

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;
		const { context } = tenantResult;

		const kind = event.queryStringParameters?.kind ?? 'report';
		if (!isSavedQueryKind(kind)) {
			return ResponseWrapper.badRequest(`kind must be one of: ${SAVED_QUERY_KINDS.join(', ')}`);
		}

		const collection = await getSavedQueriesCollection();
		const [own, shared] = await Promise.all(savedQueryListFilters(context.workspaceId, kind, context.userId).map((filter) =>
			collection.find(filter).sort({ updatedAt: -1 }).limit(MAX_SAVED_QUERIES_PER_USER).toArray(),
		));
		const queries = [...own, ...shared].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

		return ResponseWrapper.success({
			message: 'Saved queries fetched successfully',
			result: { queries: queries.map((query) => toSavedQueryResponse(query, context.userId)) },
		});
	} catch (error) {
		logError('Get saved queries handler failed', error);
		return ResponseWrapper.internalServerError('Failed to fetch saved queries');
	}
});
