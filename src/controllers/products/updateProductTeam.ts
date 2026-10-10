import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId, type UpdateFilter } from 'mongodb';
import { getDb, withTransaction } from '../../utils/db';
import type { Product } from '../../models/product';
import type { User } from '../../models/user';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { LifecycleConflictError, productLineageFilter } from '../../utils/productLifecycle';
import { canManageProductTeam, findActiveWorkspaceMember } from '../../utils/productAccess';
import { getMemberName, notify } from '../../utils/notifications';
import { flagUnavailableAssignments, touchActiveWorkflows } from '../../utils/workflowAssignments';
import { lineageIdOf } from '../../utils/workflows';

const ACTIONS = ['set-owner', 'add-contributor', 'remove-contributor'] as const;
type Action = typeof ACTIONS[number];

const EVENT_KEYS: Record<Action, string> = {
	'set-owner': 'product.owner.changed',
	'add-contributor': 'product.contributor.added',
	'remove-contributor': 'product.contributor.removed',
};

/**
 * Changes a Product's owner or contributors on every version of the Product.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		const productId = event.pathParameters?.productId;
		if (!productId || !ObjectId.isValid(productId)) return ResponseWrapper.badRequest('A valid product ID is required');
		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body);
		const action = input.action as Action;
		if (!ACTIONS.includes(action)) return ResponseWrapper.badRequest(`Invalid action. Must be one of: ${ACTIONS.join(', ')}`);
		if (typeof input.userId !== 'string' || !ObjectId.isValid(input.userId)) return ResponseWrapper.badRequest('A valid userId is required');

		const db = await getDb();
		const products = db.collection<Product>('products');
		const product = await products.findOne(tenantObjectIdFilter(productId, context.workspaceId));
		if (!product) return ResponseWrapper.notFound('Product not found');

		if (!canManageProductTeam(context, product)) {
			return ResponseWrapper.forbidden('Only the Product Owner or an admin can change the product team');
		}

		const userId = new ObjectId(input.userId);
		const isOwner = product.owner_user_id?.equals(userId) ?? false;
		const isContributor = product.contributor_user_ids?.some((id) => id.equals(userId)) ?? false;

		let member: User | null;
		let update: UpdateFilter<Product>;

		if (action === 'remove-contributor') {
			if (!isContributor) return ResponseWrapper.badRequest('This member is not a contributor');
			member = await db.collection<User>('users').findOne({ _id: userId, workspaceId: context.workspaceId });
			update = { $pull: { contributor_user_ids: userId } };
		} else {
			if (isOwner) return ResponseWrapper.badRequest('This member is already the Product Owner');
			if (action === 'add-contributor' && isContributor) return ResponseWrapper.badRequest('This member is already a contributor');

			member = await findActiveWorkspaceMember(db, context.workspaceId, input.userId);
			if (!member) return ResponseWrapper.badRequest('The member must be active in this workspace');

			update = action === 'set-owner'
				? { $set: { owner_user_id: userId }, $pull: { contributor_user_ids: userId } }
				: { $addToSet: { contributor_user_ids: userId } };
		}

		const updated = await withTransaction(async (txDb, session) => {
			const txProducts = txDb.collection<Product>('products');
			const unchanged = await txProducts.updateOne({
				_id: product._id,
				owner_user_id: product.owner_user_id ?? { $exists: false },
				contributor_user_ids: product.contributor_user_ids ?? { $exists: false },
			}, update, { session });
			if (unchanged.matchedCount === 0) throw new LifecycleConflictError('The product team changed. Reload and try again.');

			await txProducts.updateMany({ ...productLineageFilter(product), _id: { $ne: product._id } }, update, { session });
			await touchActiveWorkflows(txDb, context.workspaceId, { 'products.lineageId': lineageIdOf(product) }, session);
			return txProducts.findOne({ _id: product._id }, { projection: { owner_user_id: 1, contributor_user_ids: 1 }, session });
		});

		await recordAuditEvent({
			workspaceId: context.workspaceId.toString(),
			scope: { type: 'product', id: productId },
			entity: { type: 'product', id: productId },
			action: 'update',
			eventKey: EVENT_KEYS[action],
			visibility: 'all',
			where: { module: 'products' },
			auth: auth.payload,
			before: product as unknown as Record<string, unknown>,
			after: updated as unknown as Record<string, unknown>,
			changedPaths: ['owner_user_id', 'contributor_user_ids'],
			meta: {
				productName: product.product_name,
				memberName: member?.name,
			},
		});

		await flagUnavailableAssignments({ db, workspaceId: context.workspaceId, actorId: context.userId, lineageId: lineageIdOf(product) });

		if (action !== 'remove-contributor' && !userId.equals(context.userId)) {
			const actorName = await getMemberName(context.userId);
			await notify({
				workspaceId: context.workspaceId,
				recipients: [userId],
				...(action === 'set-owner'
					? {
						type: 'product.owner_assigned',
						title: `${actorName} made you the Product Owner of ${product.product_name}`,
						body: 'You can now edit this product and manage its team.',
					} as const
					: {
						type: 'product.contributor_added',
						title: `${actorName} added you as a contributor on ${product.product_name}`,
						body: 'You can now edit this product.',
					} as const),
				link: `/products/${productId}/product-information`,
				meta: { productId, productName: product.product_name, actorUserId: context.userId.toString() },
			});
		}

		return ResponseWrapper.success({
			message: 'Product team updated successfully',
			action,
			team: updated,
		});
	} catch (err) {
		if (err instanceof LifecycleConflictError) return ResponseWrapper.conflict(err.message);
		logError('Update product team handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update product team');
	}
};
