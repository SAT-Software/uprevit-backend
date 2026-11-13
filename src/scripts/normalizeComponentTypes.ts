import { MongoClient, ServerApiVersion } from 'mongodb';

/**
 * Rewrites the legacy "Pre-printed" label component type to "Preprinted". Safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run normalize:component-types -- [--dry-run]
 */

const LEGACY_FILTER = { 'label_components.data.component_type': 'Pre-printed' };

const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');
	const dryRun = process.argv.includes('--dry-run');

	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		const products = client.db(DB_NAME).collection('products');
		const count = await products.countDocuments(LEGACY_FILTER);
		console.log(`${dryRun ? 'Would update' : 'Updating'} ${count} product versions in ${DB_NAME}`);
		if (!dryRun && count > 0) {
			const result = await products.updateMany(
				LEGACY_FILTER,
				{ $set: { 'label_components.data.$[component].component_type': 'Preprinted' } },
				{ arrayFilters: [{ 'component.component_type': 'Pre-printed' }] },
			);
			console.log(`Updated ${result.modifiedCount} product versions`);
		}
	} finally {
		await client.close();
	}
};

main().catch((error) => {
	console.error('Component type normalization failed', error);
	process.exit(1);
});
