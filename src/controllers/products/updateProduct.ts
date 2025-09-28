import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { verifyJWT } from '../../utils/authUtils';

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

        // Extract product ID from path parameters
        const productId = event.pathParameters?.id;

        if (!productId) {
            return ResponseWrapper.badRequest('Product ID is required in path parameters');
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(productId)) {
            return ResponseWrapper.badRequest('Invalid product ID format. Must be a valid MongoDB ObjectId.');
        }

        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader) {
            return ResponseWrapper.unauthorized('Unauthorized');
        }

        const token = authHeader.split(' ')[1];

        // Check if the user is valid - both users and admins can update products
        const { isValid, payload } = await verifyJWT(token);
        if (!isValid) {
            return ResponseWrapper.unauthorized('Unauthorized');
        }

        let input: any;
        try {
            input = JSON.parse(event.body);
        } catch (error) {
            return ResponseWrapper.badRequest('Invalid JSON in request body');
        }

        // Validate required fields for action-based approach
        if (!input.action) {
            return ResponseWrapper.badRequest('action field is required');
        }

        const validActions = ['update-product', 'update-status'];
        if (!validActions.includes(input.action)) {
            return ResponseWrapper.badRequest(`Invalid action. Must be one of: ${validActions.join(', ')}`);
        }

        if (!input.data) {
            return ResponseWrapper.badRequest('data field is required');
        }

        const db = await getDb();
        const productObjectId = new ObjectId(productId);

        // Find existing product
        const existingProduct = await db.collection<Product>('products').findOne({
            _id: productObjectId,
        });

        if (!existingProduct) {
            return ResponseWrapper.notFound('Product not found');
        }

        // Prepare update data based on action
        const updateData: Partial<Product> = {};

        switch (input.action) {
            case 'update-product':
                // Update product information fields - check if at least one field is provided
                const productFields = ['product_name', 'product_description', 'target_date', 'actual_completion_date'];
                const hasProductFields = productFields.some((field) => input.data[field] !== undefined);

                if (!hasProductFields) {
                    return ResponseWrapper.badRequest(
                        'At least one product field is required: product_name, product_description, target_date, or actual_completion_date',
                    );
                }

                // Apply all provided fields directly
                for (const field of productFields) {
                    if (input.data[field] !== undefined) {
                        updateData[field as keyof Product] = input.data[field];
                    }
                }
                break;

            case 'update-status':
                // Handle status updates with business rules
                const newStatus = input.data.status;

                // Validate status value
                if (!['draft', 'submitted', 'archived'].includes(newStatus)) {
                    return ResponseWrapper.badRequest('Invalid status. Must be one of: draft, submitted, archived');
                }

                // Business rules for status transitions
                if (newStatus === 'submitted' && existingProduct.complete_count !== 100) {
                    return ResponseWrapper.badRequest(
                        'Cannot change status to "submitted" unless complete_count is 100',
                    );
                }

                updateData.status = newStatus;
                break;

            default:
                return ResponseWrapper.badRequest(`Unknown action: ${input.action}`);
        }

        // Update the product
        const result = await db
            .collection<Product>('products')
            .updateOne({ _id: productObjectId }, { $set: updateData });

        if (result.matchedCount === 0) {
            return ResponseWrapper.notFound('Product not found');
        }

        // Log the update action
        await updateAuditLog({
            entity: 'product',
            entityId: productId,
            action: AuditLogAction.UPDATE,
            actionBy: payload?.name?.toString() || 'Unknown',
            actionAt: new Date(),
            active: true,
        });

        // Fetch updated product for response
        const updatedProduct = await db.collection<Product>('products').findOne({
            _id: productObjectId,
        });

        return ResponseWrapper.success({
            message: 'Product updated successfully',
            action: input.action,
            product: updatedProduct,
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
