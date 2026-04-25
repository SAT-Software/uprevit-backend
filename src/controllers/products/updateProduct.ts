import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest, authenticateWithRole } from '../../utils/authUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';

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

		const productId = event.pathParameters?.productId;
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

		case 'update-status': {
			const newStatus = input.data.status;

			if (!['draft', 'submitted', 'archived'].includes(newStatus)) {
				return ResponseWrapper.badRequest('Invalid status. Must be one of: draft, submitted, archived');
			}

			if (newStatus !== 'submitted') {
				const statusAuth = await authenticateWithRole(event, 'admin');
				if (!statusAuth.isValid) return statusAuth.error;
			}

			if (newStatus === 'submitted' && existingProduct.complete_count !== 100) {
				return ResponseWrapper.badRequest(
					'Cannot change status to "submitted" unless complete_count is 100',
				);
			}

			updateData.status = newStatus;
			break;
		}

		default:
			return ResponseWrapper.badRequest(`Unknown action: ${input.action}`);
		}

		const result = await db
			.collection<Product>('products')
			.updateOne({ _id: productObjectId }, { $set: updateData });

		if (result.matchedCount === 0) {
			return ResponseWrapper.notFound('Product not found');
		}

		const updatedProduct = await db.collection<Product>('products').findOne({
			_id: productObjectId,
		});

		let eventKey = 'product.updated';
		let auditAction: 'update' | 'submit' | 'archive' | 'restore' = 'update';
		let visibility: 'all' | 'admin' = 'all';

		if (input.action === 'update-status') {
			visibility = 'admin';
			if (input.data.status === 'submitted') {
				eventKey = 'product.submitted';
				auditAction = 'submit';
			} else if (input.data.status === 'archived') {
				eventKey = 'product.archived';
				auditAction = 'archive';
			} else {
				eventKey = 'product.restored';
				auditAction = 'restore';
			}
		}

		await recordAuditEvent({
			workspaceId: existingProduct.workspace_id.toString(),
			scope: { type: 'product', id: productId },
			entity: { type: 'product', id: productId },
			action: auditAction,
			eventKey,
			visibility,
			where: { module: 'products' },
			auth: auth.payload,
			before: existingProduct as unknown as Record<string, unknown>,
			after: (updatedProduct ?? existingProduct) as unknown as Record<string, unknown>,
			changedPaths: Object.keys(updateData),
			meta: {
				productName: (updatedProduct?.product_name ?? existingProduct.product_name),
			},
		});

		return ResponseWrapper.success({
			message: 'Product updated successfully',
			action: input.action,
			product: updatedProduct,
		});
	} catch (err) {
		logError('Update product handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update product');
	}
};
