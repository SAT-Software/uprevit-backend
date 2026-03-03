import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { authenticateRequest } from '../../utils/authUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';
import { logError } from '../../utils/logger';
import { getProductExportJobByIdForUser } from '../../utils/productExportJobs';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { createPresignedGetUrl } from '../../utils/s3-storage';
import { validateAllObjectIds } from '../../utils/validationUtils';

/**
 * Generates a signed download URL for a completed product export job.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Signed URL response
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
			requestedBySub: cognitoSub,
			target: 'product',
		});

		if (!job || job.workspaceId.toString() !== userContext.workspaceId.toString()) {
			return ResponseWrapper.notFound('Product export job not found');
		}

		if (job.status !== 'completed' || !job.s3Key) {
			return ResponseWrapper.badRequest('Export is not ready for download');
		}

		if (job.expiresAt.getTime() <= Date.now()) {
			return ResponseWrapper.badRequest('Export file has expired');
		}

		const downloadUrl = await createPresignedGetUrl(job.s3Key);

		return ResponseWrapper.success({
			message: 'Export download URL generated successfully',
			result: {
				jobId: job._id.toString(),
				downloadUrl,
				fileName: job.fileName,
				contentType: job.contentType,
				expiresAt: job.expiresAt.toISOString(),
			},
		});
	} catch (error) {
		logError('Download product export job handler failed', error);
		return ResponseWrapper.internalServerError('Failed to generate export download URL');
	}
};
