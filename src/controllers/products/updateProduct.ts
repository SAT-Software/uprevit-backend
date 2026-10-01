import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb, withTransaction } from '../../utils/db';
import type { Product } from '../../models/product';
import type { Workspace } from '../../models/workspace';
import type { AuditAction } from '../../models/auditLogV2';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';
import { recordAuditEvent } from '../../utils/auditLogV2';
import {
	allTabsCompletedFilter,
	computeCompleteCount,
	CONTENT_LOCKED_MESSAGE,
	editableStatusFilter,
	LifecycleConflictError,
	productLineageFilter,
	releaseVersions,
} from '../../utils/productLifecycle';
import { canEditProduct, PRODUCT_EDIT_FORBIDDEN_MESSAGE, ProductAccessError, productEditorFilter } from '../../utils/productAccess';

const ACTIONS = ['update-product', 'submit', 'return-to-draft', 'archive', 'restore', 'update-status'] as const;
type Action = Exclude<typeof ACTIONS[number], 'update-status'>;

const PRODUCT_FIELDS = ['product_name', 'product_description', 'target_date', 'actual_completion_date'] as const;

type AuditInfo = { eventKey: string; action: AuditAction; changedPaths: string[] };

/**
 * Maps the legacy `update-status` payload to a lifecycle action.
 * @param {string} status Requested legacy status
 * @param {Product} product Product being changed
 * @return {Action | null} Lifecycle action, or null when the status is invalid
 */
const fromLegacyStatus = (status: unknown, product: Product): Action | null => {
	if (status === 'submitted') return 'submit';
	if (status === 'archived') return 'archive';
	if (status === 'draft') return product.is_archived ? 'restore' : 'return-to-draft';
	return null;
};

/**
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const productId = event.pathParameters?.productId;
		if (!productId) return ResponseWrapper.badRequest('Product ID is required in path parameters');
		if (!ObjectId.isValid(productId)) return ResponseWrapper.badRequest('Invalid product ID format. Must be a valid MongoDB ObjectId.');

		const input = JSON.parse(event.body);
		if (!ACTIONS.includes(input.action)) return ResponseWrapper.badRequest(`Invalid action. Must be one of: ${ACTIONS.join(', ')}`);
		if ((input.action === 'update-product' || input.action === 'update-status') && !input.data) {
			return ResponseWrapper.badRequest('data field is required');
		}

		const db = await getDb();
		const products = db.collection<Product>('products');
		const productFilter = tenantObjectIdFilter(productId, context.workspaceId);

		const existingProduct = await products.findOne(productFilter);
		if (!existingProduct) return ResponseWrapper.notFound('Product not found');

		const action = input.action === 'update-status' ? fromLegacyStatus(input.data.status, existingProduct) : input.action as Action;
		if (!action) return ResponseWrapper.badRequest('Invalid status. Must be one of: draft, submitted, archived');

		if (action === 'archive' || action === 'restore') {
			if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Only workspace admins can archive or restore products');
		} else if (!canEditProduct(context, existingProduct)) {
			return ResponseWrapper.forbidden(PRODUCT_EDIT_FORBIDDEN_MESSAGE);
		}

		let audit: AuditInfo;
		const editorFilter = productEditorFilter(context);
		const accessLost = async () => {
			const current = await products.findOne(productFilter, { projection: { owner_user_id: 1, contributor_user_ids: 1 } });
			return !current || !canEditProduct(context, current);
		};

		switch (action) {
		case 'update-product': {
			const updateData: Partial<Product> = {};
			for (const field of PRODUCT_FIELDS) {
				if (input.data[field] !== undefined) updateData[field] = input.data[field];
			}
			if (Object.keys(updateData).length === 0) {
				// complete_count is derived from the tab flags; older clients still send it on its own.
				if (input.data.complete_count !== undefined) {
					return ResponseWrapper.success({ message: 'Product updated successfully', action, product: existingProduct });
				}
				return ResponseWrapper.badRequest(`At least one product field is required: ${PRODUCT_FIELDS.join(', ')}`);
			}

			const updated = await products.updateOne({ ...productFilter, ...editableStatusFilter, ...editorFilter }, { $set: updateData });
			if (updated.matchedCount === 0) {
				return await accessLost() ? ResponseWrapper.forbidden(PRODUCT_EDIT_FORBIDDEN_MESSAGE) : ResponseWrapper.conflict(CONTENT_LOCKED_MESSAGE);
			}
			audit = { eventKey: 'product.updated', action: 'update', changedPaths: Object.keys(updateData) };
			break;
		}

		case 'submit': {
			if (existingProduct.status !== 'draft' && existingProduct.status !== 'submitted') {
				return ResponseWrapper.conflict('Only draft or submitted versions can be submitted');
			}
			if (computeCompleteCount(existingProduct) !== 100) {
				return ResponseWrapper.badRequest('A product can only be submitted when all tabs are marked complete');
			}

			const workspace = await db.collection<Workspace>('workspaces').findOne(
				{ _id: context.workspaceId },
				{ projection: { approvalWorkflowsEnabled: 1 } },
			);

			const workflowsEnabled = workspace?.approvalWorkflowsEnabled === true;
			if (workflowsEnabled && existingProduct.status === 'submitted') {
				return ResponseWrapper.conflict('Product is already submitted');
			}

			await withTransaction(async (txDb, session) => {
				const submitted = await txDb.collection<Product>('products').updateOne(
					{ ...productFilter, ...editorFilter, ...allTabsCompletedFilter, status: workflowsEnabled ? 'draft' : { $in: ['draft', 'submitted'] } },
					{ $set: { actual_completion_date: new Date(), complete_count: 100, ...(workflowsEnabled ? { status: 'submitted' as const } : {}) } },
					{ session },
				);
				if (submitted.matchedCount === 0) throw new LifecycleConflictError('This version can no longer be submitted');
				if (!workflowsEnabled) await releaseVersions(txDb, [existingProduct], { legacy: true, session });
			}).catch(async (error) => {
				if (error instanceof LifecycleConflictError && await accessLost()) throw new ProductAccessError(PRODUCT_EDIT_FORBIDDEN_MESSAGE);
				throw error;
			});

			audit = workflowsEnabled
				? { eventKey: 'product.submitted', action: 'submit', changedPaths: ['status', 'actual_completion_date'] }
				: { eventKey: 'product.released', action: 'submit', changedPaths: ['status', 'released_at', 'actual_completion_date'] };
			break;
		}

		case 'return-to-draft':
			if ((await products.updateOne({ ...productFilter, ...editorFilter, status: 'submitted' }, { $set: { status: 'draft' } })).matchedCount === 0) {
				if (await accessLost()) return ResponseWrapper.forbidden(PRODUCT_EDIT_FORBIDDEN_MESSAGE);
				return ResponseWrapper.conflict('Only submitted versions can be returned to draft');
			}
			audit = { eventKey: 'product.returned_to_draft', action: 'update', changedPaths: ['status'] };
			break;

		case 'archive':
			await withTransaction((txDb, session) => txDb.collection<Product>('products').updateMany(productLineageFilter(existingProduct), {
				$set: { is_archived: true, archived_at: new Date(), archived_by: context.userId },
			}, { session }));
			audit = { eventKey: 'product.archived', action: 'archive', changedPaths: ['is_archived'] };
			break;

		case 'restore':
			await withTransaction((txDb, session) => txDb.collection<Product>('products').updateMany(productLineageFilter(existingProduct), {
				$set: { is_archived: false },
				$unset: { archived_at: '', archived_by: '' },
			}, { session }));
			audit = { eventKey: 'product.restored', action: 'restore', changedPaths: ['is_archived'] };
			break;
		}

		const updatedProduct = await products.findOne(productFilter);

		await recordAuditEvent({
			workspaceId: existingProduct.workspace_id.toString(),
			scope: { type: 'product', id: productId },
			entity: { type: 'product', id: productId },
			action: audit.action,
			eventKey: audit.eventKey,
			visibility: action === 'update-product' ? 'all' : 'admin',
			where: { module: 'products' },
			auth: auth.payload,
			before: existingProduct as unknown as Record<string, unknown>,
			after: (updatedProduct ?? existingProduct) as unknown as Record<string, unknown>,
			changedPaths: audit.changedPaths,
			meta: {
				productName: updatedProduct?.product_name ?? existingProduct.product_name,
			},
		});

		return ResponseWrapper.success({
			message: 'Product updated successfully',
			action,
			product: updatedProduct,
		});
	} catch (err) {
		if (err instanceof LifecycleConflictError) return ResponseWrapper.conflict(err.message);
		if (err instanceof ProductAccessError) return ResponseWrapper.forbidden(err.message);
		logError('Update product handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update product');
	}
};
