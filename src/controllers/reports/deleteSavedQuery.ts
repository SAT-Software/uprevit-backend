import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { validateObjectIds } from '../../utils/validationUtils';
import { getSavedQueriesCollection, savedQueryOwnerFilter } from '../../utils/savedQueries';
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

		const collection = await getSavedQueriesCollection();
		const { deletedCount } = await collection.deleteOne(
			savedQueryOwnerFilter(new ObjectId(queryIdParam), context.workspaceId, context.userId),
		);
		if (deletedCount === 0) return ResponseWrapper.notFound('Saved query not found');

		return ResponseWrapper.success({ message: 'Saved query deleted successfully' });
	} catch (error) {
		logError('Delete saved query handler failed', error);
		return ResponseWrapper.internalServerError('Failed to delete saved query');
	}
});
