import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { UserBookmarks } from "../../models/bookmarks";

/**
 * @param {APIGatewayProxyEvent} event 
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;

		const userId = event.queryStringParameters?.userId;
		if (!userId) return ResponseWrapper.badRequest('Missing required query parameter: userId');

		const validationError = validateAllObjectIds({ userId });
		if (validationError) return validationError;

		const db = await getDb();
		const userIdObj = new ObjectId(userId);

		const bookmarks = await db.collection<UserBookmarks>('bookmarks').findOne({ user_id: userIdObj });
		const bookmarkedFolderIds = bookmarks ? bookmarks.sourceFile_folders.map(id => id.toString()) : [];
        

		const allBookmarkedFolders = await db.collection<SourceFile>('sourceFiles').find({_id: {$in: bookmarkedFolderIds.map(id => new ObjectId(id))}}).toArray();


		return ResponseWrapper.success({
			message: 'Source file folders fetched successfully.',
			result: allBookmarkedFolders
		});
        
	} catch (error) {
		console.error('Get bookmarked source file folders handler failed');
		return ResponseWrapper.internalServerError('Failed to get bookmarked source file folders');
	}
}