import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { SAVED_QUERY_KINDS, type SavedQueryDocument } from '../../models/savedQuery';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import {
	MAX_SAVED_QUERIES_PER_USER,
	MAX_SAVED_QUERY_NAME_LENGTH,
	getSavedQueriesCollection,
	isSavedQueryKind,
	normalizeSavedQueryName,
	parseJsonObject,
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

		const input = parseJsonObject(event.body);
		if (!input) return ResponseWrapper.badRequest('Request body must be a JSON object');

		if (!isSavedQueryKind(input.kind)) {
			return ResponseWrapper.badRequest(`kind must be one of: ${SAVED_QUERY_KINDS.join(', ')}`);
		}

		const name = normalizeSavedQueryName(input.name);
		if (!name) return ResponseWrapper.badRequest(`name must be 1-${MAX_SAVED_QUERY_NAME_LENGTH} characters`);

		const definitionError = validateSavedQueryDefinition(input.kind, input.definition);
		if (definitionError) return ResponseWrapper.badRequest(definitionError);

		if (input.shared !== undefined && typeof input.shared !== 'boolean') {
			return ResponseWrapper.badRequest('shared must be a boolean');
		}

		const collection = await getSavedQueriesCollection();
		const ownedCount = await collection.countDocuments({
			workspaceId: context.workspaceId,
			kind: input.kind,
			ownerUserId: context.userId,
		});
		if (ownedCount >= MAX_SAVED_QUERIES_PER_USER) return ResponseWrapper.badRequest('Saved query limit reached');

		const now = new Date();
		const document: SavedQueryDocument = {
			_id: new ObjectId(),
			workspaceId: context.workspaceId,
			ownerUserId: context.userId,
			kind: input.kind,
			name,
			definition: toSavedQueryDefinition(input.definition),
			shared: input.shared === true,
			createdAt: now,
			updatedAt: now,
		};
		await collection.insertOne(document);

		return ResponseWrapper.created({
			message: 'Saved query created successfully',
			result: { query: toSavedQueryResponse(document, context.userId) },
		});
	} catch (error) {
		logError('Create saved query handler failed', error);
		return ResponseWrapper.internalServerError('Failed to create saved query');
	}
});
