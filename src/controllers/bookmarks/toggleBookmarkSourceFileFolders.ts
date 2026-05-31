import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { requireTenantContext, tenantObjectIdFilter } from "../../utils/tenantContext";
import { getDb } from "../../utils/db";
import { validateAllObjectIds, validateMissingFields } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { UserBookmarks } from "../../models/bookmarks";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest("Request body is missing.");

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			folder_id: input.folder_id,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateAllObjectIds({
			folder_id: input.folder_id,
		});
		if (objectIdValidation) return objectIdValidation;

		const db = await getDb();
		const bookmarksCollection = db.collection<UserBookmarks>('bookmarks');
		const userId = context.userId;
		const workspaceId = context.workspaceId;
		const folderId = ObjectId.createFromHexString(input.folder_id);

		const sourceFolder = await db.collection<SourceFile>('sourceFiles').findOne(
			tenantObjectIdFilter(folderId, workspaceId),
		);
		if (!sourceFolder || sourceFolder.type !== 'folder') {
			return ResponseWrapper.notFound('Source file folder not found.');
		}

		const userBookmarks = await bookmarksCollection.findOne({
			user_id: userId,
			workspace_id: workspaceId,
		});

		let update;
		let message: string;

		if (userBookmarks && userBookmarks.sourceFile_folders.some(id => id.equals(folderId))) {
			update = { $pull: { sourceFile_folders: folderId } };
			message = 'Source file folder removed from bookmarks successfully.';
		} else {
			update = {
				$addToSet: { sourceFile_folders: folderId },
				$setOnInsert: {
					user_id: userId,
					workspace_id: workspaceId,
					product_folders: [],
				}
			};
			message = 'Source file folder added to bookmarks successfully.';
		}

		const result = await bookmarksCollection.updateOne(
			{ user_id: userId, workspace_id: workspaceId },
			update,
			{ upsert: true },
		);

		await updateAuditLog({
			entity: 'sourcefile_bookmark_folder',
			entityId: folderId.toString(),
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({
			message,
			result,
		});
	} catch (error) {
		logError('Toggle bookmark source file folders handler failed', error);
		return ResponseWrapper.internalServerError('Failed to toggle source file folder bookmark');
	}
}
