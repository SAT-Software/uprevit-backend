import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { validateAllObjectIds, validateMissingFields } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { UserBookmarks } from "../../models/bookmarks";
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
			folderId: folderIdParam,
			productId: input.product_id,
		});
		if (objectIdValidation) return objectIdValidation;

		const userId = ObjectId.createFromHexString(input.user_id);
		const folderId = ObjectId.createFromHexString(folderIdParam);
		const productId = ObjectId.createFromHexString(input.product_id);

		const db = await getDb();

		const updateResult = await db.collection<UserBookmarks>("bookmarks").findOneAndUpdate(
			{
				user_id: userId,
				"product_folders._id": folderId
			},
			{
				$pull: { "product_folders.$[folder].products": productId }
			},
			{
				arrayFilters: [{ "folder._id": folderId }],
				returnDocument: "before"
			}
		);

		console.log("updateResult", updateResult);


		if (!updateResult) {
			return ResponseWrapper.notFound("Product bookmark not removed due to product or bookmark folder not found.");
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
			message: "Product removed from bookmark folder successfully.",
			folder_id: folderId.toString(),
			product_id: productId.toString(),
		});
	} catch (error) {
		console.error("Error in deleteProductFromBookmark:", error);
		return ResponseWrapper.internalServerError("An unknown error occurred while deleting the product from the bookmark folder.");
	}
};