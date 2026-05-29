import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getDocumentationVideoObjectKey } from "../../config/documentationVideos";
import { authenticateRequest } from "../../utils/authUtils";
import { createDocumentationFilePresignedGetUrl } from "../../utils/s3-storage";
import { ResponseWrapper } from "../../utils/responseWrapper";

/**
 * Returns a short-lived signed URL for a documentation video.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Signed URL and expiry for the video
 */
export const lambdaHandler = async (
	event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) {
			return auth.error;
		}

		const videoKey = event.pathParameters?.videoKey?.trim();
		if (!videoKey) {
			return ResponseWrapper.badRequest("videoKey is required");
		}

		const objectKey = getDocumentationVideoObjectKey(videoKey);
		if (!objectKey) {
			return ResponseWrapper.notFound("Documentation video not found");
		}

		const { url, expiresAt } = await createDocumentationFilePresignedGetUrl(objectKey);

		return ResponseWrapper.success({
			message: "Documentation video URL generated",
			result: { url, expiresAt },
		});
	} catch {
		return ResponseWrapper.internalServerError("Failed to generate documentation video URL");
	}
};
