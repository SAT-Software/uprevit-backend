import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
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

        type BookmarkProductInput = {
            id: string;
            folder_id: string;
        };

        const input: BookmarkProductInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.id || !input.folder_id) {
            return ResponseWrapper.badRequest(
                'Missing required fields: id and folder_id are required'
            );
        }

        // Validate ObjectId formats
        if (!ObjectId.isValid(input.id)) {
            return ResponseWrapper.badRequest('Invalid product id format. Must be a valid MongoDB ObjectId.');
        }

        if (!ObjectId.isValid(input.folder_id)) {
            return ResponseWrapper.badRequest('Invalid folder_id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Check if product exists and is active
        const product: Product | null = await db.collection<Product>('products').findOne({
            _id: new ObjectId(input.id),
            isActive: true
        });

        if (!product) {
            return ResponseWrapper.notFound('Product not found or is not active');
        }

        // Find the user bookmarks document that contains the specified folder
        const userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            'bookmarked_product_folders._id': new ObjectId(input.folder_id)
        });

        if (!userBookmarks) {
            return ResponseWrapper.notFound('Bookmark folder not found');
        }

        // Check if product is already bookmarked in this folder
        const targetFolder = userBookmarks.bookmarked_product_folders.find(
            folder => folder._id.toString() === input.folder_id
        );

        if (!targetFolder) {
            return ResponseWrapper.notFound('Bookmark folder not found in user bookmarks');
        }

        const productAlreadyBookmarked = targetFolder.products.some(
            productId => productId.toString() === input.id
        );

        if (productAlreadyBookmarked) {
            return ResponseWrapper.badRequest('Product is already bookmarked in this folder');
        }

        // Add product to the bookmark folder
        const updateResult = await db.collection<UserBookmarks>('userBookmarks').findOneAndUpdate(
            {
                _id: userBookmarks._id,
                'bookmarked_product_folders._id': new ObjectId(input.folder_id)
            },
            {
                $push: {
                    'bookmarked_product_folders.$.products': new ObjectId(input.id)
                }
            },
            {
                returnDocument: 'after'
            }
        );

        if (!updateResult) {
            return ResponseWrapper.internalServerError('Failed to bookmark product');
        }

        // Find the updated folder to return in response
        const updatedFolder = updateResult.bookmarked_product_folders.find(
            folder => folder._id.toString() === input.folder_id
        );

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'userBookmarks',
            entityId: userBookmarks._id!.toString(),
            action: AuditLogAction.UPDATE,
            actionBy: userBookmarks.user_id.toString(),
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        return ResponseWrapper.success({
            message: 'Product bookmarked successfully',
            bookmark: {
                user_id: updateResult.user_id,
                workspace_id: updateResult.workspace_id,
                folder: updatedFolder,
                product: {
                    _id: product._id,
                    product_name: product.product_name,
                    product_plan_number: product.product_plan_number,
                    status: product.status
                }
            }
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