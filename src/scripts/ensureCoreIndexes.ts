/* eslint-disable require-jsdoc */
import { Db, MongoClient, ServerApiVersion } from 'mongodb';

/**
 * Creates the indexes behind tenant resolution, list pages and dashboard counts.
 * Only missing indexes are created, so it is safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run ensure:core-indexes -- [--dry-run]
 */

const CORE_INDEXES: Record<string, Record<string, 1 | -1>[]> = {
	users: [{ cognitoSub: 1 }, { workspaceId: 1 }],
	products: [{ workspace_id: 1, is_latest: 1 }, { product_lineage_id: 1, version: -1 }, { project_id: 1 }],
	departments: [{ workspace_id: 1, isArchived: 1 }],
	projects: [{ workspace_id: 1, isArchived: 1 }],
	sourceFiles: [{ workspace_id: 1, type: 1 }],
};

export const ensureCoreIndexes = async (db: Db, dryRun: boolean) => {
	let created = 0;
	for (const [collectionName, keys] of Object.entries(CORE_INDEXES)) {
		const collection = db.collection(collectionName);
		const indexes = await collection.indexes().catch((error) => (error?.code === 26 ? [] : Promise.reject(error)));
		const existing = new Set(indexes.map((index) => JSON.stringify(index.key)));
		const missing = keys.filter((key) => !existing.has(JSON.stringify(key)));
		for (const key of missing) console.log(`${dryRun ? 'Would create' : 'Creating'} ${collectionName} ${JSON.stringify(key)}`);
		if (!dryRun && missing.length > 0) {
			await collection.createIndexes(missing.map((key) => ({ key })));
		}
		created += missing.length;
	}
	console.log(`${dryRun ? 'Missing' : 'Created'} ${created} indexes.`);
	return created;
};

const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');

	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		await ensureCoreIndexes(client.db(DB_NAME), process.argv.includes('--dry-run'));
	} finally {
		await client.close();
	}
};

if (require.main === module) {
	main().catch((error) => {
		console.error('Core index creation failed', error);
		process.exit(1);
	});
}
