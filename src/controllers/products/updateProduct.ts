import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb, withTransaction } from '../../utils/db';
import type { Product } from '../../models/product';
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
	JUST_RELEASED_MESSAGE,
	LifecycleConflictError,
	productLineageFilter,
} from '../../utils/productLifecycle';
import { canEditProduct, PRODUCT_EDIT_FORBIDDEN_MESSAGE, ProductAccessError, productEditorFilter } from '../../utils/productAccess';
import { getMemberName, notify } from '../../utils/notifications';
import { saveProductContent, sendChangeNotices } from '../../utils/workflowChangeNotices';
import { WorkflowConflictError } from '../../utils/workflowLifecycle';

const ACTIONS = ['update-product', 'submit', 'return-to-draft', 'archive', 'restore', 'update-status'] as const;
type Action = Exclude<typeof ACTIONS[number], 'update-status'>;

const PRODUCT_FIELDS = ['product_name', 'product_description', 'target_date', 'actual_completion_date'] as const;

const IN_REVIEW_MESSAGE = 'This version is in review. Its status cannot change until its workflow ends.';

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

		if (existingProduct.status === 'in_review' && action !== 'restore' && action !== 'update-product') {
			return ResponseWrapper.conflict(IN_REVIEW_MESSAGE);
		}

		let audit: AuditInfo;
		let draftOwnerId: ObjectId | undefined;
		let changeNotice: Awaited<ReturnType<typeof saveProductContent>>['changeNotice'] = null;
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

			const saved = await saveProductContent({
				productFilter,
				writeFilter: { ...productFilter, ...editableStatusFilter, ...editorFilter },
				update: { $set: updateData },
				actorId: context.userId,
			});
			if (saved.result.matchedCount === 0) {
				if (await accessLost()) return ResponseWrapper.forbidden(PRODUCT_EDIT_FORBIDDEN_MESSAGE);
				return ResponseWrapper.conflict(existingProduct.status === 'in_review' ? JUST_RELEASED_MESSAGE : CONTENT_LOCKED_MESSAGE);
			}
			changeNotice = saved.changeNotice;
			audit = { eventKey: 'product.updated', action: 'update', changedPaths: Object.keys(updateData) };
			break;
		}

		case 'submit': {
			if (existingProduct.status === 'submitted') return ResponseWrapper.conflict('Product is already submitted');
			if (existingProduct.status !== 'draft') return ResponseWrapper.conflict('Only draft versions can be submitted');
			if (computeCompleteCount(existingProduct) !== 100) {
				return ResponseWrapper.badRequest('A product can only be submitted when all tabs are marked complete');
			}

			const submitted = await products.updateOne(
				{ ...productFilter, ...editorFilter, ...allTabsCompletedFilter, status: 'draft' },
				{ $set: { actual_completion_date: new Date(), complete_count: 100, status: 'submitted' } },
			);
			if (submitted.matchedCount === 0) {
				if (await accessLost()) return ResponseWrapper.forbidden(PRODUCT_EDIT_FORBIDDEN_MESSAGE);
				return ResponseWrapper.conflict('This version can no longer be submitted');
			}

			audit = { eventKey: 'product.submitted', action: 'submit', changedPaths: ['status', 'actual_completion_date'] };
			break;
		}

		case 'return-to-draft': {
			const returned = await products.findOneAndUpdate(
				{ ...productFilter, ...editorFilter, status: 'submitted' },
				{ $set: { status: 'draft' } },
				{ returnDocument: 'after', projection: { owner_user_id: 1 } },
			);
			if (!returned) {
				if (await accessLost()) return ResponseWrapper.forbidden(PRODUCT_EDIT_FORBIDDEN_MESSAGE);
				return ResponseWrapper.conflict('Only submitted versions can be returned to draft');
			}
			draftOwnerId = returned.owner_user_id;
			audit = { eventKey: 'product.returned_to_draft', action: 'update', changedPaths: ['status'] };
			break;
		}

		case 'archive':
			await withTransaction(async (txDb, session) => {
				const lineage = txDb.collection<Product>('products');
				if (await lineage.countDocuments({ ...productLineageFilter(existingProduct), status: 'in_review' }, { limit: 1, session })) {
					throw new LifecycleConflictError('This product is in review. End its workflow before archiving it.');
				}
				await lineage.updateMany(productLineageFilter(existingProduct), {
					$set: { is_archived: true, archived_at: new Date(), archived_by: context.userId },
				}, { session });
			});
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

		await sendChangeNotices(changeNotice);

		if (draftOwnerId && !draftOwnerId.equals(context.userId)) {
			const actorName = await getMemberName(context.userId);
			await notify({
				workspaceId: context.workspaceId,
				recipients: [draftOwnerId],
				type: 'product.returned_to_draft',
				title: `${actorName} returned ${existingProduct.product_name} to Draft`,
				body: `Version ${existingProduct.version} is no longer marked ready for review.`,
				link: `/products/${productId}/product-information`,
				meta: { productId, productName: existingProduct.product_name, version: existingProduct.version, actorUserId: context.userId.toString() },
			});
		}

		return ResponseWrapper.success({
			message: 'Product updated successfully',
			action,
			product: updatedProduct,
		});
	} catch (err) {
		if (err instanceof LifecycleConflictError || err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		if (err instanceof ProductAccessError) return ResponseWrapper.forbidden(err.message);
		logError('Update product handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update product');
	}
};
