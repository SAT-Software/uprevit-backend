import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { validateAllObjectIds, validateMissingFields } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { ProductBookmarkFolder, UserBookmarks } from "../../models/bookmarks";
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

		if(!event.body) return ResponseWrapper.badRequest('Request body is missing.');

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			user_id: input.user_id,
			workspace_id: input.workspace_id,
			folder_name: input.folder_name,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateAllObjectIds({
			'user_id': input.user_id,
			'workspace_id': input.workspace_id
		});
		if (objectIdValidation) return objectIdValidation


		const db = await getDb();
		const bookmarksCollection = db.collection<UserBookmarks>('bookmarks');
		const userId = ObjectId.createFromHexString(input.user_id);
		const workspaceId = ObjectId.createFromHexString(input.workspace_id);

		const trimmedFolderName = input.folder_name.trim();

		const existingFolder = await bookmarksCollection.findOne({
			user_id: userId,
			'product_folders.folder_name': trimmedFolderName,
		});

		if (existingFolder) {
			return ResponseWrapper.conflict('A product bookmark folder with the same name already exists.');
		}

		const newProductBookmarkFolder: ProductBookmarkFolder = {
			_id: new ObjectId(),
			folder_name: trimmedFolderName,
			products: [],
		};

		await bookmarksCollection.updateOne(
			{
				user_id: userId,
			},
			{
				$push: { product_folders: newProductBookmarkFolder },
				$setOnInsert: {
					user_id: userId,
					workspace_id: workspaceId,
					sourceFile_folders: [],
				}
			},
			{ upsert: true }
		);

		await updateAuditLog({
			entity: 'product_bookmark_folder',
			entityId: newProductBookmarkFolder._id.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Product bookmark folder created successfully.',
			folder: newProductBookmarkFolder
		});
	} catch (error) {
		logError('Create product bookmark folder handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create product bookmark folder');
	}
}