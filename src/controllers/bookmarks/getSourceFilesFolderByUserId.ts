import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { UserBookmarks } from '../../models/userBookmarks';
import { SourceFiles } from '../../models/sourceFiles';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Extract userId from query parameters
        const userId = event.queryStringParameters?.userId;

        // Validate required userId parameter
        if (!userId) {
            return ResponseWrapper.badRequest('Missing required query parameter: userId');
        }

        // Validate ObjectId format for userId
        if (!ObjectId.isValid(userId)) {
            return ResponseWrapper.badRequest('Invalid userId format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Find user bookmarks document
        const userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            user_id: new ObjectId(userId)
        });

        if (!userBookmarks) {
            return ResponseWrapper.success({
                data: []
            });
        }

        // Check if user has any bookmarked source file folders
        if (!userBookmarks.bookmarked_sourceFile_folders || userBookmarks.bookmarked_sourceFile_folders.length === 0) {
            return ResponseWrapper.success({
                data: []
            });
        }

        // Fetch the source file folders that are bookmarked by the user
        const bookmarkedFolders = await db.collection<SourceFiles>('sourceFiles').find({
            _id: { $in: userBookmarks.bookmarked_sourceFile_folders }
        }).toArray();

        // Transform the data to match the required response format
        const responseData = bookmarkedFolders.map(folder => ({
            _id: folder._id,
            folder_name: folder.folder_name,
            product_id: folder.product_id,
            workspace_id: folder.workspace_id
        }));

        return ResponseWrapper.success({
            data: responseData
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};