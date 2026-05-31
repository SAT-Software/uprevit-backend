import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { requireTenantContext } from "../../utils/tenantContext";
import { validateMissingFields } from "../../utils/validationUtils";
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
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if(!event.body) return ResponseWrapper.badRequest('Request body is missing.');

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			folder_name: input.folder_name,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const db = await getDb();
		const bookmarksCollection = db.collection<UserBookmarks>('bookmarks');
		const userId = context.userId;
		const workspaceId = context.workspaceId;

		const trimmedFolderName = input.folder_name.trim();

		const existingFolder = await bookmarksCollection.findOne({
			user_id: userId,
			workspace_id: workspaceId,
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
				workspace_id: workspaceId,
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
		logError('Create product bookmark folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to create product bookmark folder');
	}
}
