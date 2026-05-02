import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ObjectId } from "mongodb";
import { authenticateRequest } from "../../utils/authUtils";
import { getAuthenticatedUserContext } from "../../utils/authenticatedUser";
import { getDb } from "../../utils/db";
import { logError } from "../../utils/logger";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { validateMissingFields } from "../../utils/validationUtils";
import { createPresignedUrl, type UploadScope } from "../../utils/s3-storage";
import type { Product } from "../../models/product";

const PRODUCT_ASSET_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
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

const resolveUploadScope = (value: unknown): UploadScope => {
	if (value === "product-assets" || value === "source-files") return value;
	return "workspace-assets";
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
		const uploadScope = resolveUploadScope(input.uploadScope);

		if (!isAllowedContentType(contentType, uploadScope)) {
			return ResponseWrapper.badRequest(`Unsupported contentType: ${input.contentType}`);
		}

		const userContext = await getAuthenticatedUserContext(auth.payload.sub);

		if (!userContext) {
			if (uploadScope !== "workspace-assets") {
				return ResponseWrapper.forbidden('Valid Workspace is required for this upload.');
			}

			const { uploadUrl, key } = await createPresignedUrl(input.fileName!, contentType, {
				uploadScope,
				pendingOwnerId: auth.payload.sub,
			});

			return ResponseWrapper.created({ message: "Presigned URL generated successfully.", uploadUrl, key, expiresIn: 3600 });
		}

		let productId: string | undefined;
		if (uploadScope === "product-assets") {
			productId = typeof input.productId === "string" ? input.productId.trim() : "";
			if (!productId) return ResponseWrapper.badRequest('productId is required for product uploads.');
			if (!ObjectId.isValid(productId)) return ResponseWrapper.badRequest('Invalid productId.');

			const db = await getDb();
			const product = await db.collection<Product>('products').findOne({
				_id: new ObjectId(productId),
				workspace_id: userContext.workspaceId,
			}, { projection: { _id: 1 } });

			if (!product) return ResponseWrapper.forbidden('You are not authorized to upload files for this product.');
		}

		const { uploadUrl, key } = await createPresignedUrl(input.fileName!, contentType, {
			uploadScope,
			workspaceId: userContext.workspaceId.toString(),
			productId,
		});

		return ResponseWrapper.created({ message: "Presigned URL generated successfully.", uploadUrl, key, expiresIn: 3600 });
	} catch (error) {
		logError('Failed to generate presigned upload URL', error);
		return ResponseWrapper.internalServerError('Failed to generate presigned URL.');
	}
}
