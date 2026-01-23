import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";

/**
 * @param {APIGatewayProxyEvent} event 
 * @returns {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;

		const userId = event.queryStringParameters?.userId;
		if (!userId) return ResponseWrapper.badRequest('Missing required query parameter: userId');

		const  validateUserId = validateAllObjectIds({ userId });
		if (validateUserId) return validateUserId;

		// TODO: Implement this check when we connect auth and users collection
		// if(auth.payload.sub !== userId) return ResponseWrapper.unauthorized('You are not authorized to access bookmarks of other users.');

		const db = await getDb();

		const productBookmarkFolders = await db.collection('bookmarks').findOne({
			user_id: new ObjectId(userId),
		})

		if(!productBookmarkFolders) return ResponseWrapper.notFound('No product bookmark folders found for the given user.');

		return ResponseWrapper.success({
			message: 'Product bookmark folders fetched successfully.',
			result: {
				 _id: productBookmarkFolders._id,
				user_id: productBookmarkFolders.user_id,
				workspace_id: productBookmarkFolders.workspace_id,
				bookmarked_product_folders: productBookmarkFolders.product_folders || [],
			}
		})
        
	} catch (error) {
		logError('Get all product bookmark folders handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get product bookmark folders');
	}
}