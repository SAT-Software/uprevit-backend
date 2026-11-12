import { Db, MongoClient, ServerApiVersion } from 'mongodb';

/**
 * Read-only report of source file records whose S3 key is outside their workspace.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run check:source-file-keys -- [--dry-run]
 */

type SourceFileRecord = { _id: unknown; workspace_id: unknown; key?: unknown; url?: unknown };

export const checkSourceFileKeys = async (db: Db) => {
	const report: Record<string, string[]> = { foreignPrefix: [], outsideSourceFilesPrefix: [], urlOnly: [], duplicateKeys: [] };
	const keyCounts = new Map<string, string[]>();

	const cursor = db.collection<SourceFileRecord>('sourceFiles').find(
		{ type: 'file' },
		{ projection: { workspace_id: 1, key: 1, url: 1 } },
	);
	for await (const file of cursor) {
		const id = String(file._id);
		const key = typeof file.key === 'string' ? file.key.trim() : '';
		if (!key) {
			if (file.url) report.urlOnly.push(id);
			continue;
		}
		const workspacePrefix = `uploads/${String(file.workspace_id)}/`;
		if (!key.startsWith(workspacePrefix)) report.foreignPrefix.push(id);
		else if (!key.startsWith(`${workspacePrefix}source-files/`)) report.outsideSourceFilesPrefix.push(id);
		keyCounts.set(key, [...(keyCounts.get(key) ?? []), id]);
	}
	for (const ids of keyCounts.values()) {
		if (ids.length > 1) report.duplicateKeys.push(...ids);
	}

	for (const [category, ids] of Object.entries(report)) {
		console.log(`${category}: ${ids.length}${ids.length ? ` (e.g. ${ids.slice(0, 20).join(', ')})` : ''}`);
	}
	console.log('Read-only report; no changes made.');
	return report;
};

const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');

	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		await checkSourceFileKeys(client.db(DB_NAME));
	} finally {
		await client.close();
	}
};

if (require.main === module) {
	main().catch((error) => {
		console.error('Source file key report failed', error);
		process.exit(1);
	});
}
