import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { authenticateRequest } from '../../utils/authUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';
import { getExportJobByIdForUser } from '../../utils/exportJobs';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { createExportPresignedGetUrl } from '../../utils/s3-storage';
import { validateAllObjectIds } from '../../utils/validationUtils';

/**
 * Generates a signed download URL for a completed report export job.
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

		const job = await getExportJobByIdForUser({
			jobId: new ObjectId(jobId),
			workspaceId: userContext.workspaceId,
			requestedBySub: cognitoSub,
			target: 'report',
		});

		if (!job) {
			return ResponseWrapper.notFound('Report export job not found');
		}

		if (job.status !== 'completed' || !job.s3Key) {
			return ResponseWrapper.badRequest('Export is not ready for download');
		}

		if (job.expiresAt.getTime() <= Date.now()) {
			return ResponseWrapper.badRequest('Export file has expired');
		}

		const secondsUntilExpiry = Math.floor((job.expiresAt.getTime() - Date.now()) / 1000);
		const downloadUrl = await createExportPresignedGetUrl(job.s3Key, job.fileName, secondsUntilExpiry);

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
		logError('Download report export job handler failed', error);
		return ResponseWrapper.internalServerError('Failed to generate export download URL');
	}
};
