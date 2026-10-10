/* eslint-disable require-jsdoc */
import { AnyBulkWriteOperation, Db, MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import type { Product } from '../models/product';
import type { User } from '../models/user';
import { AUDIT_LOG_V2_COLLECTION, type AuditLogV2 } from '../models/auditLogV2';

/**
 * Gives every Product an owner: the creator from the `product.created` audit event when they are
 * still an active member, otherwise the workspace's first active admin. Contributors start empty.
 * Only versions without `owner_user_id` are changed, so it is safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run backfill:product-owners -- [--dry-run]
 */

type ProductRow = Pick<Product, 'workspace_id' | 'product_lineage_id' | 'owner_user_id' | 'contributor_user_ids'> & { _id: ObjectId };

export const backfillProductOwners = async (db: Db, dryRun: boolean) => {
	const productsCollection = db.collection<ProductRow>('products');

	const withoutOwner = await productsCollection
		.find({ owner_user_id: { $exists: false } }, { projection: { workspace_id: 1, product_lineage_id: 1 } })
		.toArray();
	const pending = withoutOwner.filter((product) => product.workspace_id);
	const warnings = withoutOwner
		.filter((product) => !product.workspace_id)
		.map((product) => `Product ${product._id} has no workspace; skipped`);

	const lineageIds = [...new Set(pending.map((product) => (product.product_lineage_id ?? product._id).toString()))];
	const lineageVersions = await productsCollection
		.find({ $or: [{ product_lineage_id: { $in: lineageIds.map((id) => new ObjectId(id)) } }, { _id: { $in: pending.map((product) => product._id) } }] },
			{ projection: { workspace_id: 1, product_lineage_id: 1, owner_user_id: 1 } })
		.toArray();

	const createdEvents = await db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION)
		.find({ 'eventKey': 'product.created', 'scope.type': 'product', 'scope.id': { $in: lineageVersions.map((product) => product._id.toString()) } })
		.sort({ occurredAt: 1 })
		.toArray();
	const creatorByProduct = new Map<string, AuditLogV2['actor']>();
	for (const event of createdEvents) {
		if (!creatorByProduct.has(event.scope.id)) creatorByProduct.set(event.scope.id, event.actor);
	}

	const workspaceIds = [...new Set(pending.map((product) => product.workspace_id.toString()))].map((id) => new ObjectId(id));
	const members = await db.collection<User>('users')
		.find({ workspaceId: { $in: workspaceIds }, status: 'active' }, { projection: { name: 1, email: 1, cognitoSub: 1, userType: 1, workspaceId: 1 } })
		.sort({ _id: 1 })
		.toArray();

	const findCreator = (workspaceId: ObjectId, actor?: AuditLogV2['actor']) => {
		if (!actor) return undefined;
		const workspaceMembers = members.filter((member) => member.workspaceId?.equals(workspaceId));
		const email = (actor.email ?? actor.name)?.toLowerCase();
		return workspaceMembers.find((member) => actor.userId && member.cognitoSub === actor.userId)
			?? workspaceMembers.find((member) => email && member.email.toLowerCase() === email)
			?? workspaceMembers.find((member) => ObjectId.isValid(actor.name) && member._id?.equals(actor.name));
	};
	const firstAdmin = (workspaceId: ObjectId) =>
		members.find((member) => member.workspaceId?.equals(workspaceId) && member.userType === 'admin');

	const counts = { pendingVersions: pending.length, lineages: 0, fromCreator: 0, fromAdminNoCreatedEvent: 0, fromAdminCreatorUnresolved: 0, keptExistingOwner: 0, skipped: 0 };
	const operations: AnyBulkWriteOperation<ProductRow>[] = [];

	for (const lineageId of lineageIds) {
		counts.lineages++;
		const versions = lineageVersions.filter((product) => (product.product_lineage_id ?? product._id).toString() === lineageId);
		const workspaceId = versions[0].workspace_id;

		let ownerId = versions.find((version) => version.owner_user_id)?.owner_user_id;
		if (ownerId) {
			counts.keptExistingOwner++;
		} else {
			const actors = versions.map((version) => creatorByProduct.get(version._id.toString())).filter(Boolean);
			const creator = actors.map((actor) => findCreator(workspaceId, actor)).find(Boolean);
			ownerId = creator?._id ?? firstAdmin(workspaceId)?._id;
			if (creator) counts.fromCreator++;
			else if (ownerId && actors.length === 0) counts.fromAdminNoCreatedEvent++;
			else if (ownerId) {
				counts.fromAdminCreatorUnresolved++;
				warnings.push(`Lineage ${lineageId}: creator "${actors[0]?.name}" is not an active member; using the first admin`);
			}
		}

		if (!ownerId) {
			counts.skipped++;
			warnings.push(`Lineage ${lineageId} in workspace ${workspaceId} has no creator or active admin; skipped`);
			continue;
		}

		operations.push({
			updateMany: {
				filter: { _id: { $in: versions.map((version) => version._id) }, owner_user_id: { $exists: false } },
				update: [{ $set: { owner_user_id: ownerId, contributor_user_ids: { $ifNull: ['$contributor_user_ids', []] } } }],
			},
		});
	}

	warnings.forEach((warning) => console.warn(`[warn] ${warning}`));
	console.log(dryRun ? '[dry-run] Product owner backfill plan:' : 'Product owner backfill:', { ...counts, updates: operations.length });

	if (dryRun) {
		operations.slice(0, 10).forEach((operation) => console.log(JSON.stringify(operation)));
	} else if (operations.length > 0) {
		const result = await productsCollection.bulkWrite(operations, { ordered: false });
		console.log(`Updated ${result.modifiedCount} product versions.`);
	}
	return operations.length;
};

const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');

	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		await backfillProductOwners(client.db(DB_NAME), process.argv.includes('--dry-run'));
	} finally {
		await client.close();
	}
};

if (require.main === module) {
	main().catch((error) => {
		console.error('Product owner backfill failed', error);
		process.exit(1);
	});
}
