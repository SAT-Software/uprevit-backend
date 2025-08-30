import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { UserBookmarks } from '../../models/userBookmarks';
import { Product } from '../../models/product';
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
        // Extract folderId and productId from path parameters
        const folderId = event.pathParameters?.folderId;
        const productId = event.pathParameters?.productId;

        // Validate required path parameters
        if (!folderId) {
            return ResponseWrapper.badRequest('Missing required path parameter: folderId');
        }

        if (!productId) {
            return ResponseWrapper.badRequest('Missing required path parameter: productId');
        }

        // Validate ObjectId format for folderId
        if (!ObjectId.isValid(folderId)) {
            return ResponseWrapper.badRequest('Invalid folderId format. Must be a valid MongoDB ObjectId.');
        }

        // Validate ObjectId format for productId
        if (!ObjectId.isValid(productId)) {
            return ResponseWrapper.badRequest('Invalid productId format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // First, verify that the product exists
        const product = await db.collection<Product>('products').findOne({
            _id: new ObjectId(productId)
        });

        if (!product) {
            return ResponseWrapper.notFound('Product not found');
        }

        // Find the user bookmarks document that contains the folder
        const userBookmarks: UserBookmarks | null = await db.collection<UserBookmarks>('userBookmarks').findOne({
            'bookmarked_product_folders._id': new ObjectId(folderId)
        });

        if (!userBookmarks) {
            return ResponseWrapper.notFound('Product bookmark folder not found');
        }

        // Find the specific folder to remove product from
        const targetFolder = userBookmarks.bookmarked_product_folders.find(
            folder => folder._id.toString() === folderId
        );

        if (!targetFolder) {
            return ResponseWrapper.notFound('Product bookmark folder not found in user bookmarks');
        }

        // Check if the product is actually in the folder
        const isProductInFolder = targetFolder.products.some(
            existingProductId => existingProductId.toString() === productId
        );

        if (!isProductInFolder) {
            return ResponseWrapper.badRequest('Product is not in this bookmark folder');
        }

        // Remove the product from the folder using the positional operator with $pull
        const updateResult = await db.collection<UserBookmarks>('userBookmarks').findOneAndUpdate(
            {
                _id: userBookmarks._id,
                'bookmarked_product_folders._id': new ObjectId(folderId)
            },
            {
                $pull: {
                    'bookmarked_product_folders.$.products': new ObjectId(productId)
                }
            },
            {
                returnDocument: 'after'
            }
        );

        if (!updateResult) {
            return ResponseWrapper.internalServerError('Failed to remove product from bookmark folder');
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
            message: 'Product removed from bookmark folder successfully',
            folder_id: folderId,
            product_id: productId
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};