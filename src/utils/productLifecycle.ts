import { ClientSession, Db, ObjectId } from 'mongodb';
import type { Product, ProductStatus } from '../models/product';
import { WORKFLOWS_COLLECTION, type Workflow } from '../models/workflow';

const CONTENT_LOCKED_STATUSES: ProductStatus[] = ['released', 'obsolete'];

export const CONTENT_LOCKED_MESSAGE = 'Released and obsolete versions cannot be edited';

export const JUST_RELEASED_MESSAGE = 'This version was just released and can no longer be edited';

export const isContentLocked = (status: ProductStatus) => CONTENT_LOCKED_STATUSES.includes(status);

export const editableStatusFilter = { status: { $nin: CONTENT_LOCKED_STATUSES } };

/** Thrown inside a transaction when the product changed after it was read; maps to 409. */
export class LifecycleConflictError extends Error {}

const COMPLETION_TABS = [
	'product_information',
	'compliance_information',
	'label_components',
	'symbols_graphics',
	'product_data',
	'operational_parameters',
	'label_tags',
] as const;

export const TAB_INCOMPLETE_WHILE_SUBMITTED_MESSAGE = 'Return the version to Draft before marking a tab incomplete';

export const TAB_INCOMPLETE_WHILE_IN_REVIEW_MESSAGE = 'Tabs cannot be marked incomplete while the version is in review';

/**
 * Completion percentage derived from the tab flags, never from client input.
 * @param {Product} product Version with its tab data
 * @return {number} Rounded percentage of the seven tabs marked complete
 */
export const computeCompleteCount = (product: Pick<Product, typeof COMPLETION_TABS[number]>) =>
	Math.round((COMPLETION_TABS.filter((tab) => product[tab]?.tab_completed).length / COMPLETION_TABS.length) * 100);

/** Aggregation expression for the same percentage, so it can be written in the same update as a tab flag. */
export const completeCountExpression = {
	$round: [{
		$multiply: [{
			$divide: [{ $add: COMPLETION_TABS.map((tab) => ({ $cond: [{ $eq: [`$${tab}.tab_completed`, true] }, 1, 0] })) }, COMPLETION_TABS.length],
		}, 100],
	}, 0],
};

/** Mongo filter matching versions whose seven tabs are all marked complete. */
export const allTabsCompletedFilter = Object.fromEntries(COMPLETION_TABS.map((tab) => [`${tab}.tab_completed`, true]));

export const canCreateVersion = (product: Pick<Product, 'is_latest' | 'status' | 'is_archived'>) =>
	product.is_latest && product.status === 'released' && !product.is_archived;

export const productLineageFilter = (product: Pick<Product, '_id' | 'workspace_id' | 'product_lineage_id'>) => ({
	workspace_id: product.workspace_id,
	product_lineage_id: product.product_lineage_id ?? (product._id as ObjectId),
});

/**
 * Releases the given versions and makes each lineage's previous release obsolete.
 * Throws `LifecycleConflictError` if a version is already released or obsolete. Pass a session to keep it atomic.
 * @param {Db} db Database handle
 * @param {Product[]} versions Versions to release
 * @param {Object} options `workflowId` records the releasing workflow and clears its lock; `session` joins a transaction
 */
export const releaseVersions = async (
	db: Db,
	versions: Pick<Product, '_id' | 'workspace_id' | 'product_lineage_id'>[],
	{ workflowId, session }: { workflowId?: ObjectId; session?: ClientSession } = {},
) => {
	const products = db.collection<Product>('products');
	const now = new Date();

	for (const version of versions) {
		const released = await products.updateOne(
			{ _id: version._id, status: { $nin: ['released', 'obsolete'] } },
			{
				$set: { status: 'released', released_at: now, ...(workflowId && { released_by_workflow_id: workflowId }) },
				...(workflowId && { $unset: { active_workflow_id: '' } }),
			},
			{ session },
		);
		if (released.matchedCount === 0) throw new LifecycleConflictError('This version is already released');

		await products.updateMany(
			{ ...productLineageFilter(version), status: 'released', _id: { $ne: version._id } },
			{ $set: { status: 'obsolete', obsoleted_at: now } },
			{ session },
		);
	}
};

/**
 * Builds the list filter for the `status` query param. `archived` selects archived products;
 * anything else filters active products by lifecycle status.
 * @param {string} statusParam JSON array or single status value
 * @return {Object} Mongo match and whether the archive list was requested
 */
export const buildProductStatusMatch = (statusParam?: string) => {
	let statuses: string[] = [];
	if (statusParam) {
		try {
			const parsed = JSON.parse(statusParam);
			statuses = (Array.isArray(parsed) ? parsed : [parsed]).filter((status): status is string => typeof status === 'string');
		} catch {
			statuses = [statusParam];
		}
	}

	if (statuses.includes('archived')) {
		return { isArchive: true, match: { is_archived: true } };
	}

	return {
		isArchive: false,
		match: {
			is_archived: { $ne: true },
			...(statuses.length > 0 ? { status: { $in: statuses } } : {}),
		},
	};
};

type ReleaseInfoSource = { _id?: ObjectId; product_lineage_id?: ObjectId; active_workflow_id?: ObjectId };

/**
 * Adds each product's `released_version` (its lineage's current release) and `active_workflow` (the workflow reviewing it),
 * so a row can show both the working and the released version.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace id
 * @param {T[]} products Product versions
 * @return {Promise<Array>} Products with `released_version` and `active_workflow`, each null when there is none
 */
export const addProductReleaseInfo = async <T extends ReleaseInfoSource>(db: Db, workspaceId: ObjectId, products: T[]) => {
	const lineageIdOf = (product: T) => (product.product_lineage_id ?? product._id!).toString();
	const lineageIds = products.map((product) => product.product_lineage_id ?? product._id!);
	const workflowIds = products.flatMap((product) => (product.active_workflow_id ? [product.active_workflow_id] : []));
	const [released, workflows] = await Promise.all([
		lineageIds.length
			? db.collection<Product>('products')
				.find({
					workspace_id: workspaceId,
					status: 'released',
					$or: [{ product_lineage_id: { $in: lineageIds } }, { _id: { $in: lineageIds }, product_lineage_id: { $exists: false } }],
				}, { projection: { product_lineage_id: 1, version: 1 } })
				.toArray()
			: [],
		workflowIds.length
			? db.collection<Workflow>(WORKFLOWS_COLLECTION).find({ workspaceId, _id: { $in: workflowIds } }, { projection: { numberLabel: 1 } }).toArray()
			: [],
	]);

	const releasedByLineage = new Map(released.map((version) => [(version.product_lineage_id ?? version._id!).toString(), { id: version._id!, version: version.version }]));
	const workflowById = new Map(workflows.map((workflow) => [workflow._id!.toString(), { id: workflow._id!, numberLabel: workflow.numberLabel }]));
	return products.map((product) => ({
		...product,
		released_version: releasedByLineage.get(lineageIdOf(product)) ?? null,
		active_workflow: (product.active_workflow_id && workflowById.get(product.active_workflow_id.toString())) || null,
	}));
};
