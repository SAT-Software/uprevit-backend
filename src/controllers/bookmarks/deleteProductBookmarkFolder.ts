import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { UserBookmarks } from '../../models/userBookmarks';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
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
        // Extract folderId from path parameters
        const folderId = event.pathParameters?.folderId;

        // Validate required folderId path parameter
        if (!folderId) {
            return ResponseWrapper.badRequest('Missing required path parameter: folderId');
        }

        // Validate ObjectId format for folderId
        if (!ObjectId.isValid(folderId)) {
            return ResponseWrapper.badRequest('Invalid folderId format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Find the user bookmarks document that contains the folder
        const userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            'bookmarked_product_folders._id': new ObjectId(folderId)
        });

        if (!userBookmarks) {
            return ResponseWrapper.notFound('Product bookmark folder not found');
        }

        // Find the specific folder to delete for verification
        const targetFolder = userBookmarks.bookmarked_product_folders.find(
            folder => folder._id.toString() === folderId
        );

        if (!targetFolder) {
            return ResponseWrapper.notFound('Product bookmark folder not found in user bookmarks');
        }

        // Delete the folder using $pull to remove the specific folder object
        const deleteResult = await db.collection<UserBookmarks>('userBookmarks').findOneAndUpdate(
            {
                _id: userBookmarks._id
            },
            {
                $pull: { 
                    bookmarked_product_folders: { 
                        _id: new ObjectId(folderId) 
                    } 
                }
            },
            {
                returnDocument: 'after'
            }
        );

        if (!deleteResult) {
            return ResponseWrapper.internalServerError('Failed to delete product bookmark folder');
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'userBookmarks',
            entityId: userBookmarks._id!.toString(),
            action: AuditLogAction.DELETE,
            actionBy: userBookmarks.user_id.toString(), // Using user_id from the bookmark
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Return success response
        return ResponseWrapper.success({
            message: 'Product bookmark folder deleted successfully',
            deleted_folder_id: folderId
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};