import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { authenticateRequest } from '../../utils/authUtils';
import { toExportJobSummary } from '../../utils/exportJobSerializers';
import { logError } from '../../utils/logger';
import { getProductExportJobByIdForUser } from '../../utils/productExportJobs';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';

/**
 * Gets a single product export job by id.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Product export job details
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

		const job = await getProductExportJobByIdForUser({
			jobId: new ObjectId(jobId),
			workspaceId: userContext.workspaceId,
			requestedBySub: cognitoSub,
			target: 'product',
		});

		if (!job) {
			return ResponseWrapper.notFound('Product export job not found');
		}

		return ResponseWrapper.success({
			message: 'Product export job fetched successfully',
			result: toExportJobSummary(job),
		});
	} catch (error) {
		logError('Get product export job handler failed', error);
		return ResponseWrapper.internalServerError('Failed to fetch product export job');
	}
};
