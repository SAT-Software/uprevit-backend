import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import type { SavedQuery } from '../../models/savedQuery';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { validateObjectIds } from '../../utils/validationUtils';
import {
	MAX_SAVED_QUERY_NAME_LENGTH,
	getSavedQueriesCollection,
	normalizeSavedQueryName,
	parseJsonObject,
	savedQueryOwnerFilter,
	toSavedQueryDefinition,
	toSavedQueryResponse,
	validateSavedQueryDefinition,
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

		const queryIdParam = event.pathParameters?.queryId ?? '';
		const idError = validateObjectIds({ queryId: queryIdParam });
		if (idError) return idError;
		const ownerFilter = savedQueryOwnerFilter(new ObjectId(queryIdParam), context.workspaceId, context.userId);

		const input = parseJsonObject(event.body);
		if (!input || Object.keys(input).length === 0) return ResponseWrapper.badRequest('Request body must include changes');

		const changes: Partial<Pick<SavedQuery, 'name' | 'definition' | 'shared'>> = {};
		if (input.name !== undefined) {
			const name = normalizeSavedQueryName(input.name);
			if (!name) return ResponseWrapper.badRequest(`name must be 1-${MAX_SAVED_QUERY_NAME_LENGTH} characters`);
			changes.name = name;
		}
		if (input.shared !== undefined) {
			if (typeof input.shared !== 'boolean') return ResponseWrapper.badRequest('shared must be a boolean');
			changes.shared = input.shared;
		}

		const collection = await getSavedQueriesCollection();
		if (input.definition !== undefined) {
			const existing = await collection.findOne(ownerFilter, { projection: { kind: 1 } });
			if (!existing) return ResponseWrapper.notFound('Saved query not found');
			const definitionError = validateSavedQueryDefinition(existing.kind, input.definition);
			if (definitionError) return ResponseWrapper.badRequest(definitionError);
			changes.definition = toSavedQueryDefinition(input.definition);
		}
		if (Object.keys(changes).length === 0) return ResponseWrapper.badRequest('Request body must include changes');

		const updated = await collection.findOneAndUpdate(
			ownerFilter,
			{ $set: { ...changes, updatedAt: new Date() } },
			{ returnDocument: 'after' },
		);
		if (!updated) return ResponseWrapper.notFound('Saved query not found');

		return ResponseWrapper.success({
			message: 'Saved query updated successfully',
			result: { query: toSavedQueryResponse(updated, context.userId) },
		});
	} catch (error) {
		logError('Update saved query handler failed', error);
		return ResponseWrapper.internalServerError('Failed to update saved query');
	}
});
