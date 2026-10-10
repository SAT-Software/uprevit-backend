/* eslint-disable require-jsdoc */
import { AnyBulkWriteOperation, Collection, Db, MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import type { Product } from '../models/product';
import { AUDIT_LOG_V2_COLLECTION, type AuditLogV2 } from '../models/auditLogV2';

/**
 * Moves products to the Released/Obsolete lifecycle and the separate archive flag.
 * Only products without `product_lineage_id` are migrated, so it is safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run migrate:product-lifecycle -- [--dry-run]
 */

type LegacyStatus = Product['status'] | 'archived';
type ProductRow = Pick<Product, 'workspace_id' | 'version' | 'is_latest' | 'product_lineage_id' | 'is_archived'> & {
	_id: ObjectId;
	parent_id?: ObjectId | string | null;
	status: LegacyStatus;
};

const latestEventsByProduct = async (
	audit: Collection<AuditLogV2>,
	eventKey: string,
	productIds: string[],
) => {
	if (productIds.length === 0) return new Map<string, AuditLogV2>();
	const events = await audit
		.find({ 'eventKey': eventKey, 'scope.type': 'product', 'scope.id': { $in: productIds } })
		.sort({ occurredAt: -1 })
		.toArray();
	const byProduct = new Map<string, AuditLogV2>();
	for (const event of events) {
		if (!byProduct.has(event.scope.id)) byProduct.set(event.scope.id, event);
	}
	return byProduct;
};

export const migrateProductLifecycle = async (db: Db, dryRun: boolean) => {
	const productsCollection = db.collection<ProductRow>('products');
	const audit = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);

	const products = await productsCollection
		.find({}, { projection: { workspace_id: 1, parent_id: 1, version: 1, is_latest: 1, status: 1, product_lineage_id: 1, is_archived: 1 } })
		.toArray();
	const byId = new Map(products.map((product) => [product._id.toString(), product]));
	const pending = products.filter((product) => !product.product_lineage_id);
	const warnings: string[] = [];

	const rootOf = (product: ProductRow): ObjectId => {
		if (product.product_lineage_id) return product.product_lineage_id;
		const seen = new Set<string>();
		let current = product;
		while (current.parent_id && !seen.has(current._id.toString())) {
			seen.add(current._id.toString());
			const parent = byId.get(current.parent_id.toString());
			if (!parent) {
				warnings.push(`Product ${current._id} has a missing parent ${current.parent_id}; using it as the lineage root`);
				break;
			}
			current = parent;
		}
		return current.product_lineage_id ?? current._id;
	};

	const lineages = new Map<string, { lineageId: ObjectId; versions: ProductRow[] }>();
	for (const product of products) {
		const lineageId = rootOf(product);
		const lineage = lineages.get(lineageId.toString()) ?? { lineageId, versions: [] };
		lineage.versions.push(product);
		lineages.set(lineageId.toString(), lineage);
	}

	const pendingIds = pending.map((product) => product._id.toString());
	const [archiveEvents, submitEvents] = await Promise.all([
		latestEventsByProduct(audit, 'product.archived', pending.filter((product) => product.status === 'archived').map((product) => product._id.toString())),
		latestEventsByProduct(audit, 'product.submitted', pendingIds),
	]);

	const now = new Date();
	const counts = { products: products.length, pending: pending.length, lineages: 0, unarchivedStatusFromEvent: 0, unarchivedStatusDefaulted: 0, archivedProducts: 0, released: 0, obsolete: 0 };
	const operations: AnyBulkWriteOperation<ProductRow>[] = [];

	for (const { lineageId, versions } of lineages.values()) {
		if (!versions.some((version) => !version.product_lineage_id)) continue;
		counts.lineages++;
		if (versions.filter((version) => version.is_latest).length !== 1) {
			warnings.push(`Lineage ${lineageId} has ${versions.filter((version) => version.is_latest).length} latest versions`);
		}

		const updates = new Map<string, Record<string, unknown>>();
		const set = (version: ProductRow, fields: Record<string, unknown>) =>
			updates.set(version._id.toString(), { ...updates.get(version._id.toString()), ...fields });

		const statusOf = new Map<string, LegacyStatus>();
		for (const version of versions) {
			let status = version.status;
			if (status === 'archived') {
				const from = archiveEvents.get(version._id.toString())?.changes?.find((change) => change.path === 'status')?.from;
				status = from === 'draft' || from === 'submitted' ? from : 'draft';
				if (status === from) counts.unarchivedStatusFromEvent++;
				else counts.unarchivedStatusDefaulted++;
				set(version, { status });
			}
			statusOf.set(version._id.toString(), status);
			if (!version.product_lineage_id) set(version, { product_lineage_id: lineageId });
		}

		const latest = versions.find((version) => version.is_latest) ?? versions.reduce((a, b) => (b.version > a.version ? b : a));
		const isArchived = latest.status === 'archived' || latest.is_archived === true;
		if (isArchived) counts.archivedProducts++;
		for (const version of versions) {
			if (version.is_archived !== isArchived) {
				set(version, isArchived
					? { is_archived: true, archived_at: archiveEvents.get(latest._id.toString())?.occurredAt ?? now }
					: { is_archived: false });
			}
		}

		const releaseCandidates = versions
			.filter((version) => statusOf.get(version._id.toString()) === 'released' ||
				(statusOf.get(version._id.toString()) === 'submitted' && !version.product_lineage_id))
			.sort((a, b) => b.version - a.version);
		releaseCandidates.forEach((version, index) => {
			if (index === 0) {
				if (statusOf.get(version._id.toString()) === 'released') return;
				counts.released++;
				set(version, {
					status: 'released',
					legacy_release: true,
					released_at: submitEvents.get(version._id.toString())?.occurredAt ?? now,
				});
			} else {
				counts.obsolete++;
				set(version, { status: 'obsolete', obsoleted_at: now });
			}
		});

		for (const [id, fields] of updates) {
			operations.push({ updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: fields } } });
		}
	}

	warnings.forEach((warning) => console.warn(`[warn] ${warning}`));
	console.log(dryRun ? '[dry-run] Product lifecycle migration plan:' : 'Product lifecycle migration:', { ...counts, updates: operations.length });

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
		await migrateProductLifecycle(client.db(DB_NAME), process.argv.includes('--dry-run'));
	} finally {
		await client.close();
	}
};

if (require.main === module) {
	main().catch((error) => {
		console.error('Product lifecycle migration failed', error);
		process.exit(1);
	});
}
