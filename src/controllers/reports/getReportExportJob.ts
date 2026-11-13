import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { toExportJobSummary } from '../../utils/exportJobSerializers';
import { getExportJobByIdForUser } from '../../utils/exportJobs';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Gets a single report export job by id.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Report export job details
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;
		const { context: userContext } = tenantResult;
		const { cognitoSub } = userContext;

		const jobId = event.pathParameters?.jobId;
		if (!jobId) {
			return ResponseWrapper.badRequest("Job id - 'jobId' is required in path parameters");
		}

		const validationError = validateAllObjectIds({ jobId });
		if (validationError) return validationError;

		const job = await getExportJobByIdForUser({
			jobId: new ObjectId(jobId),
			workspaceId: userContext.workspaceId,
			requestedBySub: cognitoSub,
			target: 'report',
		});

		if (!job) {
			return ResponseWrapper.notFound('Report export job not found');
		}

		return ResponseWrapper.success({
			message: 'Report export job fetched successfully',
			result: toExportJobSummary(job),
		});
	} catch (error) {
		logError('Get report export job handler failed', error);
		return ResponseWrapper.internalServerError('Failed to fetch report export job');
	}
});
