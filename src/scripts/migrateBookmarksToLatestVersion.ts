/* eslint-disable require-jsdoc */
import { AnyBulkWriteOperation, Db, MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import type { Product } from '../models/product';
import type { UserBookmarks } from '../models/bookmarks';

/**
 * Points product bookmarks that still reference an older version at the latest version of the same product.
 * Bookmarks already on the latest version are left alone, so it is safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run migrate:bookmarks-latest-version -- [--dry-run]
 */

export const migrateBookmarksToLatestVersion = async (db: Db, dryRun: boolean) => {
	const bookmarks = await db.collection<UserBookmarks>('bookmarks')
		.find({ 'product_folders.0': { $exists: true } }, { projection: { product_folders: 1 } })
		.toArray();
	const bookmarkedIds = [...new Set(bookmarks.flatMap((bookmark) => bookmark.product_folders.flatMap((folder) => folder.products ?? []).map(String)))];

	const products = db.collection<Product>('products');
	const stale = await products
		.find({ _id: { $in: bookmarkedIds.map((id) => new ObjectId(id)) }, is_latest: false }, { projection: { product_lineage_id: 1 } })
		.toArray();
	const lineageOf = new Map(stale.map((product) => [product._id!.toString(), (product.product_lineage_id ?? product._id!).toString()]));
	const latest = await products
		.find({ product_lineage_id: { $in: [...new Set(lineageOf.values())].map((id) => new ObjectId(id)) }, is_latest: true }, { projection: { product_lineage_id: 1 } })
		.toArray();
	const latestByLineage = new Map(latest.map((product) => [product.product_lineage_id!.toString(), product._id!]));
	const latestOf = (id: ObjectId) => latestByLineage.get(lineageOf.get(id.toString()) ?? '') ?? id;

	let movedBookmarks = 0;
	const operations: AnyBulkWriteOperation<UserBookmarks>[] = [];
	for (const bookmark of bookmarks) {
		let changed = false;
		const productFolders = bookmark.product_folders.map((folder) => {
			const ids = (folder.products ?? []).map(latestOf);
			const unique = ids.filter((id, index) => ids.findIndex((other) => other.equals(id)) === index);
			if (unique.length !== folder.products.length || unique.some((id, index) => !id.equals(folder.products[index]))) {
				changed = true;
				movedBookmarks += folder.products.filter((id) => !latestOf(id).equals(id)).length;
			}
			return { ...folder, products: unique };
		});
		if (changed) operations.push({ updateOne: { filter: { _id: bookmark._id, product_folders: bookmark.product_folders }, update: { $set: { product_folders: productFolders } } } });
	}

	console.log(dryRun ? '[dry-run] Bookmark migration plan:' : 'Bookmark migration:', {
		bookmarkDocuments: bookmarks.length,
		staleVersions: stale.length,
		movedBookmarks,
		updates: operations.length,
	});
	if (!dryRun && operations.length > 0) {
		const result = await db.collection<UserBookmarks>('bookmarks').bulkWrite(operations, { ordered: false });
		console.log(`Updated ${result.modifiedCount} of ${operations.length} bookmark documents. Rerun to retry any that changed during the run.`);
	}
	return operations.length;
};

const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');
	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		await migrateBookmarksToLatestVersion(client.db(DB_NAME), process.argv.includes('--dry-run'));
	} finally {
		await client.close();
	}
};

if (require.main === module) {
	main().catch((error) => {
		console.error('Bookmark migration failed', error);
		process.exit(1);
	});
}
