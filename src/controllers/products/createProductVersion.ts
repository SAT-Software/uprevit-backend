import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { ObjectId } from "mongodb";
import { Product } from "../../models/product";
import { deepCopyWithFreshIds } from "../../utils/deepCopy";
import { recordAuditEvent } from "../../utils/auditLogV2";


/**
 * @param {APIGatewayProxyEvent} event 
 * @returns {Promise<APIGatewayProxyResult>}
 */


export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);	
		if(!auth.isValid) return auth.error;

		const productId = event.pathParameters?.productId;
		if(!productId) return ResponseWrapper.badRequest('Product ID is required');

		const db = await getDb();

		const currentProduct = await db.collection<Product>('products').findOne({ _id: new ObjectId(productId), status: 'submitted', is_latest: true });

		if(!currentProduct) return ResponseWrapper.notFound('Product not found or not submitted to create new version');

		const revisedProduct = deepCopyWithFreshIds(currentProduct);

		const revisedUpdatedProduct =  {...revisedProduct, is_latest: true, parent_id: currentProduct._id, version: currentProduct.version + 1, status: 'draft' as const, complete_count: 0, target_date: null, actual_completion_date: null, product_information: {...revisedProduct.product_information, tab_completed: false}, compliance_information: {...revisedProduct.compliance_information, tab_completed: false}, label_components: {...revisedProduct.label_components, tab_completed: false}, symbols_graphics: {...revisedProduct.symbols_graphics, tab_completed: false}, product_data: {...revisedProduct.product_data, tab_completed: false}, operational_parameters: {...revisedProduct.operational_parameters, tab_completed: false}, label_tags: {...revisedProduct.label_tags, tab_completed: false}};

		await db.collection<Product>('products').findOneAndUpdate({ _id: currentProduct._id }, { $set: { is_latest: false } });
       
		const insertedProduct = await db.collection<Product>('products').insertOne(revisedUpdatedProduct);
		

		await recordAuditEvent({
			workspaceId: revisedUpdatedProduct.workspace_id.toString(),
			scope: { type: 'product', id: insertedProduct.insertedId.toString() },
			entity: { type: 'product', id: insertedProduct.insertedId.toString() },
			action: 'create',
			eventKey: 'product.version.created',
			visibility: 'all',
			where: { module: 'products' },
			auth: auth.payload,
			before: {
				version: currentProduct.version,
				is_latest: currentProduct.is_latest,
				status: currentProduct.status,
			},
			after: {
				version: revisedUpdatedProduct.version,
				is_latest: revisedUpdatedProduct.is_latest,
				status: revisedUpdatedProduct.status,
			},
			changedPaths: ['version', 'is_latest', 'status'],
			meta: {
				productName: revisedUpdatedProduct.product_name,
				fromVersion: currentProduct.version,
				toVersion: revisedUpdatedProduct.version,
			},
		});

		return ResponseWrapper.created({
			message: 'Product version created successfully',
			product: revisedUpdatedProduct,
		});
	} catch (error) {
		logError('Create product version handler failed', error);
		return ResponseWrapper.internalServerError('Failed to create product version');
	}
}
