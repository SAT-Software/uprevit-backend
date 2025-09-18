import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
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
        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

        type ProductUpdateInput = {
            id: string;
            product_name: string;
            product_description: string;
        };

        const input: ProductUpdateInput = JSON.parse(event.body);

        if (!input.id || !input.product_name || !input.product_description) {
            return ResponseWrapper.badRequest(
                'Missing required fields: id, product_name, and product_description are required',
            );
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(input.id)) {
            return ResponseWrapper.badRequest('Invalid id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        const productRecord: Product | null = await db.collection<Product>('products').findOne({
            _id: new ObjectId(input.id),
        });

        if (!productRecord) {
            return ResponseWrapper.notFound('Product not found');
        }

        const updatedProduct = await db.collection<Product>('products').findOneAndUpdate(
            {
                _id: new ObjectId(input.id),
            },
            {
                $set: {
                    product_name: input.product_name,
                    product_description: input.product_description,
                },
            },
            {
                returnDocument: 'after',
            }
        );

        if (!updatedProduct) {
            return ResponseWrapper.internalServerError('Failed to update product');
        }

        const auditRecord: AuditLog = {
            entity: 'product',
            entityId: input.id,
            action: AuditLogAction.UPDATE,
            actionBy: 'system', // You may want to get this from the event context or headers
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        return ResponseWrapper.success({
            message: 'Product updated successfully',
            product: updatedProduct,
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};