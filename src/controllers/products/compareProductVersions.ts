import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { ObjectId } from "mongodb";
import { Product } from "../../models/product";
import { deepDiff } from "../../utils/deepDiff";

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const productId = event.pathParameters?.productId;
		if (!productId) return ResponseWrapper.badRequest('Product ID is required');

		if (!ObjectId.isValid(productId)) return ResponseWrapper.badRequest('Invalid Product ID format');


		const db = await getDb();

		const baseVersion = await db.collection<Product>('products').findOne({
			_id: new ObjectId(productId)
		});

		if (!baseVersion) return ResponseWrapper.notFound('Product not found');

		const nextVersion = await db.collection<Product>('products').findOne({
			parent_id: new ObjectId(productId)
		});

		if (!nextVersion) return ResponseWrapper.notFound('No next version found for this product. This may be the latest version.');

		const diffs = deepDiff(baseVersion, nextVersion);

		return ResponseWrapper.success({
			message: 'Comparison completed successfully',
			result: {
				base_version: baseVersion,
				next_version: nextVersion,
				total_changes: diffs.length,
				diffs: diffs
			}
		});
	} catch (error) {
		console.error('Compare product versions handler failed');
		return ResponseWrapper.internalServerError('Failed to compare product versions');
	}
}
