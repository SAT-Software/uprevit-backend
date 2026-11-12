import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { requireTenantContext } from "../../utils/tenantContext";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { UserBookmarks } from "../../models/bookmarks";
import { ObjectId } from "mongodb";
import { withTelemetry } from '../../utils/telemetry';

/**
 * @param {APIGatewayProxyEvent} event
 * @returns {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const folderId = event.pathParameters?.folderId;
		if(!folderId) return ResponseWrapper.badRequest('Folder ID is missing from path parameters.');

		const objectIdValidation = validateAllObjectIds({ 
			folderId, 
		});
		if (objectIdValidation) return objectIdValidation;

		const db = await getDb();
		const bookmarksCollection = db.collection<UserBookmarks>('bookmarks');
		const userIdObj = context.userId;
		const folderIdObj = ObjectId.createFromHexString(folderId);

		const result = await bookmarksCollection.updateOne(
			{
				user_id: userIdObj,
				workspace_id: context.workspaceId,
				'product_folders._id': folderIdObj
			},
			{
				$pull: { product_folders: { _id: folderIdObj } }
			}
		);

		if (result.matchedCount === 0) return ResponseWrapper.notFound('Product bookmark folder not found.');

		return ResponseWrapper.success({
			message: 'Product bookmark folder deleted successfully.',
			result: result
		});
	} catch (error) {
		logError('Delete product bookmark folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to delete product bookmark folder');
	}
})
