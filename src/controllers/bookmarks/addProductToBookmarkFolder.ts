import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { validateAllObjectIds, validateMissingFields } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { UserBookmarks } from "../../models/bookmarks";
import type { Product } from "../../models/product";
import { ObjectId } from "mongodb";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";

/**
 * @param {APIGatewayProxyEvent} event
 * @returns {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const folderIdParam = event.pathParameters?.folderId;
		if (!folderIdParam) return ResponseWrapper.badRequest("Folder ID is missing from path parameters.");

		if (!event.body) return ResponseWrapper.badRequest("Request body is missing.");

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			user_id: input.user_id,
			product_id: input.product_id,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateAllObjectIds({
			user_id: input.user_id,
			product_id: input.product_id,
			folderId: folderIdParam,
		});
		if (objectIdValidation) return objectIdValidation;

		const userId = ObjectId.createFromHexString(input.user_id);
		const productId = ObjectId.createFromHexString(input.product_id);
		const folderId = ObjectId.createFromHexString(folderIdParam);

		const db = await getDb();

		const productExists = await db.collection<Product>("products").countDocuments({ _id: productId });
		if (productExists === 0) {
			return ResponseWrapper.notFound("Product not found.");
		}

		const updateResult = await db.collection<UserBookmarks>("bookmarks").updateOne(
			{
				user_id: userId,
				"product_folders._id": folderId,
			},
			{
				$addToSet: { "product_folders.$.products": productId },
			}
		);

		if (updateResult.modifiedCount === 0) {
			if (updateResult.matchedCount === 0) {
				return ResponseWrapper.notFound("Product bookmark folder not found.");
			}
			return ResponseWrapper.conflict("Product is already bookmarked in this folder.");
		}

		await updateAuditLog({
			entity: "product_bookmark_folder",
			entityId: folderId.toString(),
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({
			message: "Product added to bookmark folder successfully.",
			folder_id: folderId.toString(),
			product_id: productId.toString(),
		});
	} catch (error) {
		console.error("Error in addProductToBookmarkFolder:", error);
		return ResponseWrapper.internalServerError(
			error instanceof Error ? error.message : "An unknown error occurred while adding the product to the bookmark folder."
		);
	}
};