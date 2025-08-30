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

        type ArchiveProductInput = {
            id: string;
        };

        const input: ArchiveProductInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.id) {
            return ResponseWrapper.badRequest(
                'Missing required field: id is required'
            );
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(input.id)) {
            return ResponseWrapper.badRequest('Invalid id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Check if product exists and is not already archived
        const productRecord: Product | null = await db.collection<Product>('products').findOne({
            _id: new ObjectId(input.id),
            isActive: true,
            status: { $ne: 'archive' }
        });

        if (!productRecord) {
            return ResponseWrapper.notFound('Product not found or already archived');
        }

        // Archive the product by setting status to 'archive' and isActive to false
        const updateResult = await db.collection<Product>('products').findOneAndUpdate(
            {
                _id: new ObjectId(input.id),
            },
            {
                $set: {
                    status: 'archive',
                    isActive: false,
                },
            },
            {
                returnDocument: 'after',
            }
        );

        if (!updateResult) {
            return ResponseWrapper.internalServerError('Failed to archive product');
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'product',
            entityId: input.id,
            action: AuditLogAction.ARCHIVE,
            actionBy: 'system', // You may want to get this from the event context or headers
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        return ResponseWrapper.success({
            message: 'Product archived successfully',
            product: updateResult,
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