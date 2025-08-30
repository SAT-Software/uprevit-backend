import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { UserBookmarks } from '../../models/userBookmarks';
import { Product } from '../../models/product';
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

        // Find the specific folder
        const targetFolder = userBookmarks.bookmarked_product_folders.find(
            folder => folder._id.toString() === folderId
        );

        if (!targetFolder) {
            return ResponseWrapper.notFound('Product bookmark folder not found in user bookmarks');
        }

        // If folder has no products, return empty array
        if (!targetFolder.products || targetFolder.products.length === 0) {
            return ResponseWrapper.success({
                folder_name: targetFolder.folder_name,
                products: []
            });
        }

        // Get the full product details for all products in the folder
        const productIds = targetFolder.products;
        const products = await db.collection<Product>('products')
            .find({
                _id: { $in: productIds }
            })
            .project({
                _id: 1,
                product_name: 1,
                status: 1,
                master_version: 1
            })
            .toArray();

        // Map products to the response format, maintaining the order from the folder
        const orderedProducts = productIds.map(productId => {
            const product = products.find(p => p._id!.toString() === productId.toString());
            if (product) {
                return {
                    _id: product._id,
                    name: product.product_name,
                    status: product.status,
                    master_version: product.master_version
                };
            }
            return null;
        }).filter(product => product !== null); // Remove any null entries (deleted products)

        // Return success response with folder name and products
        return ResponseWrapper.success({
            folder_name: targetFolder.folder_name,
            products: orderedProducts
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};