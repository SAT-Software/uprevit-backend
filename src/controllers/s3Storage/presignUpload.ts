import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { authenticateRequest } from "../../utils/authUtils";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { validateMissingFields } from "../../utils/validationUtils";
import { createPresignedUrl } from "../../utils/s3-storage";

const PRODUCT_ASSET_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
]);

const SOURCE_FILE_EXTRA_CONTENT_TYPES = new Set([
	"application/pdf",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"image/vnd.adobe.photoshop",
	"application/photoshop",
	"application/x-photoshop",
	"application/postscript",
	"application/illustrator",
	"application/vnd.adobe.illustrator",
]);

const isAllowedContentType = (contentType: string, uploadScope: string): boolean => {
	if (PRODUCT_ASSET_CONTENT_TYPES.has(contentType)) return true;
	if (uploadScope === "source-files") return SOURCE_FILE_EXTRA_CONTENT_TYPES.has(contentType);
	return false;
};

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

		const contentType = input.contentType!.trim().toLowerCase();
		const uploadScope = input.uploadScope === "source-files" ? "source-files" : "product-assets";

		if (!isAllowedContentType(contentType, uploadScope)) {
			return ResponseWrapper.badRequest(`Unsupported contentType: ${input.contentType}`);
		}

		const { uploadUrl, key } = await createPresignedUrl(input.fileName!, contentType);

		return ResponseWrapper.created({ message: "Presigned URL generated successfully.", uploadUrl, key, expiresIn: 3600 });
	} catch (error) {
		return ResponseWrapper.internalServerError('Failed to generate presigned URL.');
	}
}
