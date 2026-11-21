import { Document, MongoClient, ServerApiVersion } from 'mongodb';
import { GLOBAL_SEARCH_INDEX, GLOBAL_SEARCH_INDEXES } from '../utils/globalSearch';

/**
 * Creates or updates the Atlas Search indexes behind global search.
 * Unchanged indexes are skipped, so it is safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run ensure:search-indexes -- [--dry-run]
 */
const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');
	const dryRun = process.argv.includes('--dry-run');

	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		const db = client.db(DB_NAME);
		for (const [collectionName, definition] of Object.entries(GLOBAL_SEARCH_INDEXES)) {
			const collection = db.collection(collectionName);
			const [existing] = await collection.listSearchIndexes(GLOBAL_SEARCH_INDEX).toArray() as Document[];
			if (existing && JSON.stringify(existing.latestDefinition?.mappings) === JSON.stringify(definition.mappings)) {
				console.log(`Unchanged ${collectionName} (${existing.status})`);
				continue;
			}
			console.log(`${dryRun ? 'Would' : 'Will'} ${existing ? 'update' : 'create'} ${collectionName}`);
			if (dryRun) continue;
			if (existing) await collection.updateSearchIndex(GLOBAL_SEARCH_INDEX, definition);
			else await collection.createSearchIndex({ name: GLOBAL_SEARCH_INDEX, definition });
		}
	} finally {
		await client.close();
	}
};

main().catch((error) => {
	console.error('Search index setup failed', error);
	process.exit(1);
});
