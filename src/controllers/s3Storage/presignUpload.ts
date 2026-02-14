import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { authenticateRequest } from "../../utils/authUtils";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { validateMissingFields } from "../../utils/validationUtils";
import { createPresignedUrlWithClient } from "../../utils/s3-storage";

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;
        
		if (!event.body) return ResponseWrapper.badRequest('Request body is missing.');
        
		const input = JSON.parse(event.body);
        
		const missingFieldsResult = validateMissingFields({
			fileName: input.fileName,
			contentType: input.contentType
		});
		if (missingFieldsResult) return missingFieldsResult;

		const { uploadUrl, key } = await createPresignedUrlWithClient(input.fileName, input.contentType);

		return ResponseWrapper.created({ message: "Presigned URL generated successfully.", uploadUrl, key, expiresIn: 3600 });
	} catch (error) {
		return ResponseWrapper.internalServerError('Failed to generate presigned URL.');
	}
}