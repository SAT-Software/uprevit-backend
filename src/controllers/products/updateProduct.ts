import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;


		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const productId = event.pathParameters?.id;
		if (!productId) return ResponseWrapper.badRequest('Product ID is required in path parameters');
		if (!ObjectId.isValid(productId)) return ResponseWrapper.badRequest('Invalid product ID format. Must be a valid MongoDB ObjectId.');

	
		const input = JSON.parse(event.body);
		

		if (!input.action) return ResponseWrapper.badRequest('action field is required');
		const validActions = ['update-product', 'update-status'];
		if (!validActions.includes(input.action)) return ResponseWrapper.badRequest(`Invalid action. Must be one of: ${validActions.join(', ')}`);


		if (!input.data) return ResponseWrapper.badRequest('data field is required');


		const db = await getDb();
		const productObjectId = new ObjectId(productId);


		const existingProduct = await db.collection<Product>('products').findOne({
			_id: productObjectId,
		});

		if (!existingProduct) return ResponseWrapper.notFound('Product not found');


		const updateData: Partial<Product> = {};

		switch (input.action) {
		case 'update-product':
			const productFields = ['product_name', 'product_description', 'target_date', 'actual_completion_date', 'complete_count'];
			const hasProductFields = productFields.some((field) => input.data[field] !== undefined);

			if (!hasProductFields) {
				return ResponseWrapper.badRequest(
					'At least one product field is required: product_name, product_description, target_date, complete_count or actual_completion_date',
				);
			}

			for (const field of productFields) {
				if (input.data[field] !== undefined) {
					updateData[field as keyof Product] = input.data[field];
				}
			}
			break;

		case 'update-status':
			const newStatus = input.data.status;

			if (!['draft', 'submitted', 'archived'].includes(newStatus)) {
				return ResponseWrapper.badRequest('Invalid status. Must be one of: draft, submitted, archived');
			}

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

		const result = await db
			.collection<Product>('products')
			.updateOne({ _id: productObjectId }, { $set: updateData });

		if (result.matchedCount === 0) {
			return ResponseWrapper.notFound('Product not found');
		}

		await updateAuditLog({
			entity: 'product',
			entityId: productId,
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

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
