import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
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
		if(!auth.isValid) return auth.error;

		const folderId = event.pathParameters?.folderId;
		if(!folderId) return ResponseWrapper.badRequest('Folder ID is missing from path parameters.');

		if(!event.body) return ResponseWrapper.badRequest('Request body is missing.');

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			user_id: input.user_id,
			folder_name: input.folder_name,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateAllObjectIds({
			'user_id': input.user_id,
			'folderId': folderId
		});
		if (objectIdValidation) return objectIdValidation

		const db = await getDb();
		const bookmarksCollection = db.collection<UserBookmarks>('bookmarks');
		const userId = ObjectId.createFromHexString(input.user_id);
		const productBookmarkFolderId = ObjectId.createFromHexString(folderId);

		const trimmedFolderName = input.folder_name.trim();

		const existingFolderWithSameName = await bookmarksCollection.findOne({
			user_id: userId,
			product_folders: {
				$elemMatch: {
					folder_name: trimmedFolderName,
					_id: { $ne: productBookmarkFolderId },
				},
			},
		});

		if (existingFolderWithSameName) {
			return ResponseWrapper.conflict('A product bookmark folder with the same name already exists.');
		}

		const result = await bookmarksCollection.updateOne(
			{
				user_id: userId,
				'product_folders._id': productBookmarkFolderId
			},
			{
				$set: { 'product_folders.$.folder_name': trimmedFolderName }
			}
		);

		if (result.matchedCount === 0) {
			return ResponseWrapper.notFound('Product bookmark folder not found.');
		}

		await updateAuditLog({
			entity: 'product_bookmark_folder',
			entityId: folderId,
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({
			message: 'Product bookmark folder updated successfully.',
			result: result
		});
	} catch (error) {
		logError('Update product bookmark folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to update product bookmark folder');
	}
}