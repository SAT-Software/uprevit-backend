import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { UserBookmarks, BookmarkProductFolder } from '../../models/userBookmarks';
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

        type CreateProductBookmarkFolderInput = {
            id: string; // user_id
            folder_name: string;
            workspace_id?: string; // Optional for backward compatibility
        };

        const input: CreateProductBookmarkFolderInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.id || !input.folder_name) {
            return ResponseWrapper.badRequest(
                'Missing required fields: id and folder_name are required'
            );
        }

        // Validate ObjectId format for user id
        if (!ObjectId.isValid(input.id)) {
            return ResponseWrapper.badRequest('Invalid id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate folder name
        if (input.folder_name.trim().length === 0) {
            return ResponseWrapper.badRequest('Folder name cannot be empty');
        }

        if (input.folder_name.length > 100) {
            return ResponseWrapper.badRequest('Folder name cannot exceed 100 characters');
        }

        // If workspace_id is provided, validate it
        if (input.workspace_id && !ObjectId.isValid(input.workspace_id)) {
            return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Find existing user bookmarks or prepare for creation
        let userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            user_id: new ObjectId(input.id),
            ...(input.workspace_id && { workspace_id: new ObjectId(input.workspace_id) })
        });

        // If no user bookmarks found and no workspace_id provided, get workspace from user
        let workspaceId: ObjectId;
        if (!userBookmarks && !input.workspace_id) {
            // Get user's workspace from user document or department
            const user = await db.collection('users').findOne({ _id: new ObjectId(input.id) });
            if (!user) {
                return ResponseWrapper.notFound('User not found');
            }
            
            // Try to get workspace_id from user document, or find from departments
            if (user.workspace_id) {
                workspaceId = new ObjectId(user.workspace_id);
            } else {
                // Find workspace through department
                const department = await db.collection('departments').findOne({ 
                    $or: [
                        { admin_id: new ObjectId(input.id) },
                        { users: new ObjectId(input.id) }
                    ]
                });
                
                if (!department || !department.workspace_id) {
                    return ResponseWrapper.badRequest('Unable to determine workspace for user. Please provide workspace_id in request body');
                }
                
                workspaceId = new ObjectId(department.workspace_id);
            }
        } else if (input.workspace_id) {
            workspaceId = new ObjectId(input.workspace_id);
        } else {
            workspaceId = userBookmarks!.workspace_id;
        }

        // Create new product folder object
        const newProductFolder: BookmarkProductFolder = {
            _id: new ObjectId(),
            folder_name: input.folder_name.trim(),
            products: []
        };

        let result: UserBookmarks;

        if (userBookmarks) {
            // Check if folder name already exists for this user
            const existingFolder = userBookmarks.bookmarked_product_folders?.find(
                folder => folder.folder_name.toLowerCase() === input.folder_name.trim().toLowerCase()
            );

            if (existingFolder) {
                return ResponseWrapper.badRequest('A folder with this name already exists');
            }

            // Update existing user bookmarks by adding the new folder
            const updateResult = await db.collection<UserBookmarks>('userBookmarks').findOneAndUpdate(
                {
                    user_id: new ObjectId(input.id),
                    workspace_id: workspaceId
                },
                {
                    $push: { bookmarked_product_folders: newProductFolder }
                },
                {
                    returnDocument: 'after'
                }
            );

            if (!updateResult) {
                return ResponseWrapper.internalServerError('Failed to create product bookmark folder');
            }

            result = updateResult;
        } else {
            // Create new user bookmarks document with the new folder
            const newUserBookmarks: Omit<UserBookmarks, '_id'> & { _id: ObjectId } = {
                _id: new ObjectId(),
                user_id: new ObjectId(input.id),
                workspace_id: workspaceId,
                bookmarked_sourceFile_folders: [],
                bookmarked_product_folders: [newProductFolder]
            };

            const insertResult = await db.collection<UserBookmarks>('userBookmarks').insertOne(newUserBookmarks);

            if (!insertResult.insertedId) {
                return ResponseWrapper.internalServerError('Failed to create product bookmark folder');
            }

            result = { ...newUserBookmarks, _id: insertResult.insertedId };
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'userBookmarks',
            entityId: result._id!.toString(),
            action: userBookmarks ? AuditLogAction.UPDATE : AuditLogAction.CREATE,
            actionBy: input.id,
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Return the complete user bookmarks structure
        const responseData = {
            _id: result._id,
            user_id: result.user_id,
            workspace_id: result.workspace_id,
            bookmarked_product_folders: result.bookmarked_product_folders
        };

        return ResponseWrapper.success(responseData);

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }

        // Handle MongoDB duplicate key errors
        if (err instanceof Error && err.message.includes('E11000')) {
            return ResponseWrapper.badRequest('A folder with this name already exists');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};