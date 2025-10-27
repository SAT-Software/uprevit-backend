import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { validateAllObjectIds } from "../../utils/validationUtils";
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

		// TODO - Get user id from auth token in future 
 		const userId = event.queryStringParameters?.user_id;
		if (!userId) return ResponseWrapper.badRequest('Missing required query parameter: user_id');

		const objectIdValidation = validateAllObjectIds({ 
			userId, 
			folderId 
		});
		if (objectIdValidation) return objectIdValidation

		const db = await getDb();
		const bookmarksCollection = db.collection<UserBookmarks>('bookmarks');
		const userIdObj = ObjectId.createFromHexString(userId);
		const folderIdObj = ObjectId.createFromHexString(folderId);

		const result = await bookmarksCollection.updateOne(
			{
				user_id: userIdObj,
				'product_folders._id': folderIdObj
			},
			{
				$pull: { product_folders: { _id: folderIdObj } }
			}
		);

		if (result.matchedCount === 0) return ResponseWrapper.notFound('Product bookmark folder not found.');

		await updateAuditLog({
			entity: 'product_bookmark_folder',
			entityId: folderId,
			action: AuditLogAction.DELETE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({
			message: 'Product bookmark folder deleted successfully.',
			result: result
		});
	} catch (error) {
		console.error('Error in deleting the product bookmark folder:', error);
		return ResponseWrapper.internalServerError('An error occurred while deleting the product bookmark folder.');
	}
}