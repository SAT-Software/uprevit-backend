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
        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

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

        type UpdateFolderNameInput = {
            folder_name: string;
        };

        const input: UpdateFolderNameInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.folder_name) {
            return ResponseWrapper.badRequest('Missing required field: folder_name is required');
        }

        // Validate folder name
        if (input.folder_name.trim().length === 0) {
            return ResponseWrapper.badRequest('Folder name cannot be empty');
        }

        if (input.folder_name.length > 100) {
            return ResponseWrapper.badRequest('Folder name cannot exceed 100 characters');
        }

        const db = await getDb();

        // Find the user bookmarks document that contains the folder
        const userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            'bookmarked_product_folders._id': new ObjectId(folderId)
        });

        if (!userBookmarks) {
            return ResponseWrapper.notFound('Product bookmark folder not found');
        }

        // Find the specific folder to update and check if new name already exists
        const targetFolder = userBookmarks.bookmarked_product_folders.find(
            folder => folder._id.toString() === folderId
        );

        if (!targetFolder) {
            return ResponseWrapper.notFound('Product bookmark folder not found in user bookmarks');
        }

        // Check if the new folder name already exists for this user (case-insensitive, excluding current folder)
        const existingFolder = userBookmarks.bookmarked_product_folders.find(
            folder => folder._id.toString() !== folderId && 
                     folder.folder_name.toLowerCase() === input.folder_name.trim().toLowerCase()
        );

        if (existingFolder) {
            return ResponseWrapper.badRequest('A folder with this name already exists');
        }

        // Update the folder name using the positional operator
        const updateResult = await db.collection<UserBookmarks>('userBookmarks').findOneAndUpdate(
            {
                _id: userBookmarks._id,
                'bookmarked_product_folders._id': new ObjectId(folderId)
            },
            {
                $set: {
                    'bookmarked_product_folders.$.folder_name': input.folder_name.trim()
                }
            },
            {
                returnDocument: 'after'
            }
        );

        if (!updateResult) {
            return ResponseWrapper.internalServerError('Failed to update product bookmark folder name');
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'userBookmarks',
            entityId: userBookmarks._id!.toString(),
            action: AuditLogAction.UPDATE,
            actionBy: userBookmarks.user_id.toString(), // Using user_id from the bookmark
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Return success response
        return ResponseWrapper.success({
            message: 'Product bookmark folder updated successfully',
            folder_id: folderId
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};