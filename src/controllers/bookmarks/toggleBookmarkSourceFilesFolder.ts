import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { UserBookmarks } from '../../models/userBookmarks';
import { SourceFiles } from '../../models/sourceFiles';
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

        type ToggleBookmarkInput = {
            user_id: string;
            workspace_id: string;
        };

        const input: ToggleBookmarkInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.user_id || !input.workspace_id) {
            return ResponseWrapper.badRequest(
                'Missing required fields: user_id and workspace_id are required'
            );
        }

        // Validate ObjectId formats
        if (!ObjectId.isValid(input.user_id)) {
            return ResponseWrapper.badRequest('Invalid user_id format. Must be a valid MongoDB ObjectId.');
        }

        if (!ObjectId.isValid(input.workspace_id)) {
            return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Check if source files folder exists
        const sourceFilesFolder: SourceFiles | null = await db.collection<SourceFiles>('sourceFiles').findOne({
            _id: new ObjectId(folderId)
        });

        if (!sourceFilesFolder) {
            return ResponseWrapper.notFound('Source files folder not found');
        }

        // Check if the folder belongs to the specified workspace
        if (sourceFilesFolder.workspace_id.toString() !== input.workspace_id) {
            return ResponseWrapper.badRequest('Source files folder does not belong to the specified workspace');
        }

        // Find or create user bookmarks document
        let userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            user_id: new ObjectId(input.user_id),
            workspace_id: new ObjectId(input.workspace_id)
        });

        let isBookmarked = false;
        let updateOperation;
        let auditAction: AuditLogAction;

        if (userBookmarks) {
            // Check if folder is already bookmarked
            isBookmarked = userBookmarks.bookmarked_sourceFile_folders.some(
                bookmarkedFolderId => bookmarkedFolderId.toString() === folderId
            );

            if (isBookmarked) {
                // Remove from bookmarks (unbookmark)
                updateOperation = {
                    $pull: { bookmarked_sourceFile_folders: new ObjectId(folderId) }
                };
                auditAction = AuditLogAction.DELETE;
            } else {
                // Add to bookmarks
                updateOperation = {
                    $push: { bookmarked_sourceFile_folders: new ObjectId(folderId) }
                };
                auditAction = AuditLogAction.UPDATE;
            }

            // Update existing user bookmarks
            const updateResult = await db.collection<UserBookmarks>('userBookmarks').findOneAndUpdate(
                {
                    user_id: new ObjectId(input.user_id),
                    workspace_id: new ObjectId(input.workspace_id)
                },
                updateOperation,
                {
                    returnDocument: 'after'
                }
            );

            if (!updateResult) {
                return ResponseWrapper.internalServerError('Failed to update bookmark');
            }

            userBookmarks = updateResult;
        } else {
            // Create new user bookmarks document with the folder bookmarked
            const newUserBookmarks: Omit<UserBookmarks, '_id'> & { _id: ObjectId } = {
                _id: new ObjectId(),
                user_id: new ObjectId(input.user_id),
                workspace_id: new ObjectId(input.workspace_id),
                bookmarked_sourceFile_folders: [new ObjectId(folderId)],
                bookmarked_product_folders: []
            };

            const insertResult = await db.collection<UserBookmarks>('userBookmarks').insertOne(newUserBookmarks);

            if (!insertResult.insertedId) {
                return ResponseWrapper.internalServerError('Failed to create bookmark');
            }

            userBookmarks = { ...newUserBookmarks, _id: insertResult.insertedId };
            auditAction = AuditLogAction.CREATE;
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'userBookmarks',
            entityId: userBookmarks._id!.toString(),
            action: auditAction,
            actionBy: input.user_id,
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Prepare response data
        const responseData = {
            _id: userBookmarks._id,
            user_id: userBookmarks.user_id,
            workspace_id: userBookmarks.workspace_id,
            bookmarked_sourceFile_folders: userBookmarks.bookmarked_sourceFile_folders,
            message: isBookmarked ? 
                'Source files folder removed from bookmarks successfully' : 
                'Source files folder bookmarked successfully'
        };

        return ResponseWrapper.success(responseData);

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};