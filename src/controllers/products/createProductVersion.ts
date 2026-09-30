import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';
import { getDb, withTransaction } from "../../utils/db";
import { Product } from "../../models/product";
import { deepCopyWithFreshIds } from "../../utils/deepCopy";
import { recordAuditEvent } from "../../utils/auditLogV2";
import { canCreateVersion, LifecycleConflictError, productLineageFilter } from "../../utils/productLifecycle";

const CREATE_VERSION_CONFLICT = 'A new version can only be created from the latest released version';


/**
 * @param {APIGatewayProxyEvent} event 
 * @returns {Promise<APIGatewayProxyResult>}
 */


export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		const productId = event.pathParameters?.productId;
		if(!productId) return ResponseWrapper.badRequest('Product ID is required');

		const db = await getDb();

		const currentProduct = await db.collection<Product>('products').findOne(
			tenantObjectIdFilter(productId, context.workspaceId),
		);

		if(!currentProduct) return ResponseWrapper.notFound('Product not found');
		if(!canCreateVersion(currentProduct)) {
			return ResponseWrapper.conflict(CREATE_VERSION_CONFLICT);
		}

		// eslint-disable-next-line camelcase, no-unused-vars
		const { released_at, obsoleted_at, legacy_release, ...revisedProduct } = deepCopyWithFreshIds(currentProduct);

		const revisedUpdatedProduct =  {...revisedProduct, product_lineage_id: productLineageFilter(currentProduct).product_lineage_id, is_latest: true, parent_id: currentProduct._id, version: currentProduct.version + 1, status: 'draft' as const, complete_count: 0, target_date: null, actual_completion_date: null, product_information: {...revisedProduct.product_information, tab_completed: false}, compliance_information: {...revisedProduct.compliance_information, tab_completed: false}, languages_information: revisedProduct.languages_information || { data: [] }, label_components: {...revisedProduct.label_components, tab_completed: false}, symbols_graphics: {...revisedProduct.symbols_graphics, tab_completed: false}, product_data: {...revisedProduct.product_data, tab_completed: false}, operational_parameters: {...revisedProduct.operational_parameters, tab_completed: false}, label_tags: {...revisedProduct.label_tags, tab_completed: false}};

		const insertedProduct = await withTransaction(async (txDb, session) => {
			const products = txDb.collection<Product>('products');
			const claimed = await products.updateOne(
				{ ...tenantObjectIdFilter(currentProduct._id!, context.workspaceId), is_latest: true, status: 'released', is_archived: { $ne: true } },
				{ $set: { is_latest: false } },
				{ session },
			);
			if (claimed.matchedCount === 0) throw new LifecycleConflictError(CREATE_VERSION_CONFLICT);
			return products.insertOne(revisedUpdatedProduct, { session });
		});

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
		if (error instanceof LifecycleConflictError) return ResponseWrapper.conflict(error.message);
		logError('Create product version handler failed', error);
		return ResponseWrapper.internalServerError('Failed to create product version');
	}
}
