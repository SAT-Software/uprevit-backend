import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ObjectId } from "mongodb";
import { authenticateRequest } from "../../utils/authUtils";
import { getAuthenticatedUserContext } from "../../utils/authenticatedUser";
import { getDb } from "../../utils/db";
import { logError } from "../../utils/logger";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { validateMissingFields } from "../../utils/validationUtils";
import { createPresignedUrl, UPLOAD_MAX_BYTES, type UploadScope } from "../../utils/s3-storage";
import type { Product } from "../../models/product";
import { assertUsageActionAllowed, checkUploadWouldExceedLimit } from "../../utils/billing/enforcement";
import { denyProductContentEdit } from "../../utils/productAccess";
import { canEditWorkspaceData, parseCognitoGroups, READ_ONLY_MESSAGE } from "../../utils/tenantContext";
import { ACTIVE_WORKFLOW_STATUSES } from "../../models/workflow";
import { canComment, getProductTeamIds } from "../../utils/workflowDiscussion";
import { findWorkflow } from "../../utils/workflows";
import { withTelemetry } from '../../utils/telemetry';

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
	if (value === "product-assets" || value === "source-files" || value === "workflow-attachments") return value;
	return "workspace-assets";
};

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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

		const sizeBytes = input.sizeBytes;
		if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return ResponseWrapper.badRequest('sizeBytes must be a positive integer.');
		if (sizeBytes > UPLOAD_MAX_BYTES[uploadScope]) {
			return ResponseWrapper.badRequest(`Files for this upload must be ${UPLOAD_MAX_BYTES[uploadScope] / (1024 * 1024)} MB or smaller.`);
		}

		const userContext = await getAuthenticatedUserContext(auth.payload.sub);

		if (!userContext) {
			if (uploadScope !== "workspace-assets") {
				return ResponseWrapper.forbidden('Valid Workspace is required for this upload.');
			}

			const { uploadUrl, key } = await createPresignedUrl(input.fileName!, contentType, {
				uploadScope,
				pendingOwnerId: auth.payload.sub,
				sizeBytes,
			});

			return ResponseWrapper.created({ message: "Presigned URL generated successfully.", uploadUrl, key, expiresIn: 3600 });
		}

		if (uploadScope === "source-files" && !canEditWorkspaceData(userContext)) {
			return ResponseWrapper.forbidden(READ_ONLY_MESSAGE);
		}

		if (userContext.workspaceId) {
			const uploadCheck = await assertUsageActionAllowed(userContext.workspaceId, 'upload');
			if (!uploadCheck.allowed) return ResponseWrapper.forbidden(uploadCheck.reason);

			const limitCheck = await checkUploadWouldExceedLimit(userContext.workspaceId, sizeBytes);
			if (!limitCheck.allowed) {
				return ResponseWrapper.forbidden(limitCheck.reason ?? 'Upload limit reached');
			}
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
			}, { projection: { owner_user_id: 1, contributor_user_ids: 1, status: 1, is_archived: 1, is_latest: 1 } });

			if (!product) return ResponseWrapper.forbidden('You are not authorized to upload files for this product.');
			const actor = { userId: userContext.userId, userType: userContext.userType, cognitoGroups: parseCognitoGroups(auth.payload['cognito:groups']) };
			const editDenied = denyProductContentEdit(actor, product);
			if (editDenied) return editDenied;
		}

		let workflowId: string | undefined;
		if (uploadScope === "workflow-attachments") {
			const db = await getDb();
			const workflow = await findWorkflow(db, userContext.workspaceId, typeof input.workflowId === "string" ? input.workflowId : undefined);
			if (!workflow) return ResponseWrapper.notFound('Workflow not found.');
			if (!ACTIVE_WORKFLOW_STATUSES.includes(workflow.status)) return ResponseWrapper.conflict('This workflow has already ended.');
			const actor = { userId: userContext.userId, cognitoGroups: parseCognitoGroups(auth.payload['cognito:groups']) };
			if (!canComment(actor, workflow, await getProductTeamIds(db, workflow))) {
				return ResponseWrapper.forbidden('Only people involved in this workflow can attach images.');
			}
			workflowId = workflow._id!.toString();
		}

		const { uploadUrl, key } = await createPresignedUrl(input.fileName!, contentType, {
			uploadScope,
			workspaceId: userContext.workspaceId.toString(),
			productId,
			workflowId,
			userId: userContext.userId.toString(),
			sizeBytes,
		});

		return ResponseWrapper.created({ message: "Presigned URL generated successfully.", uploadUrl, key, expiresIn: 3600 });
	} catch (error) {
		logError('Failed to generate presigned upload URL', error);
		return ResponseWrapper.internalServerError('Failed to generate presigned URL.');
	}
})
