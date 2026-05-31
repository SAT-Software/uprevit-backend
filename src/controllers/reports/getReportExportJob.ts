import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { authenticateRequest } from '../../utils/authUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';
import { toExportJobSummary } from '../../utils/exportJobSerializers';
import { getExportJobByIdForUser } from '../../utils/exportJobs';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds } from '../../utils/validationUtils';

/**
 * Gets a single report export job by id.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Report export job details
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const jobId = event.pathParameters?.jobId;
		if (!jobId) {
			return ResponseWrapper.badRequest("Job id - 'jobId' is required in path parameters");
		}

		const validationError = validateAllObjectIds({ jobId });
		if (validationError) return validationError;

		const cognitoSub = auth.payload.sub;
		if (!cognitoSub) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const userContext = await getAuthenticatedUserContext(cognitoSub);
		if (!userContext) {
			return ResponseWrapper.unauthorized('Unable to resolve authenticated user context');
		}

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
};
