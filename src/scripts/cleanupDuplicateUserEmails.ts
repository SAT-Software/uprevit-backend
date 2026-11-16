import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';

/**
 * Normalizes user emails (trim + lowercase) and removes phantom user records that claim an email
 * already owned by another account, so the case-insensitive unique email index can be created.
 * A phantom is an invited record with no Cognito identity that no project, department or product
 * references. Groups with more than one remaining account are reported for manual review and left
 * untouched. Safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... npm run cleanup:duplicate-user-emails -- [--dry-run]
 * Then: npm run ensure:core-indexes
 */

type UserRecord = { _id: ObjectId; email: string; cognitoSub?: string; status?: string; workspaceId?: ObjectId };

const isPhantom = (user: UserRecord) => !user.cognitoSub && user.status === 'invited';

const main = async () => {
	const { MONGODB_URI, DB_NAME } = process.env;
	if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME are required');
	const dryRun = process.argv.includes('--dry-run');

	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		const db = client.db(DB_NAME);
		const users = db.collection<UserRecord>('users');
		const groups = new Map<string, UserRecord[]>();
		for (const user of await users.find({ email: { $type: 'string' } }).toArray()) {
			const email = user.email.trim().toLowerCase();
			groups.set(email, [...(groups.get(email) ?? []), user]);
		}

		const isReferenced = async (id: ObjectId) => Boolean(
			await db.collection('projects').findOne({ $or: [{ users: id }, { admin_id: id }] }, { projection: { _id: 1 } })
			?? await db.collection('departments').findOne({ $or: [{ users: id }, { admin_id: id }] }, { projection: { _id: 1 } })
			?? await db.collection('products').findOne(
				{ $or: [{ owner_user_id: id }, { contributor_user_ids: id }] },
				{ projection: { _id: 1 } },
			),
		);
		const phantoms: UserRecord[] = [];
		const renames: Array<{ user: UserRecord; email: string }> = [];
		const unresolved: string[] = [];
		for (const [email, records] of groups) {
			let kept = records;
			if (records.length > 1) {
				const referenced = new Set<UserRecord>();
				for (const user of records) if (isPhantom(user) && await isReferenced(user._id)) referenced.add(user);
				const real = records.filter((user) => !isPhantom(user) || referenced.has(user));
				const keep = real.length ? real : [records[0]];
				phantoms.push(...records.filter((user) => !keep.includes(user)));
				kept = keep;
				if (keep.length > 1) unresolved.push(email);
			}
			if (kept.length === 1 && kept[0].email !== email) renames.push({ user: kept[0], email });
		}

		console.log(`${DB_NAME}: ${dryRun ? 'would delete' : 'deleting'} ${phantoms.length} phantom users, `
			+ `${dryRun ? 'would normalize' : 'normalizing'} ${renames.length} emails`);
		for (const user of phantoms) console.log(`  phantom ${user._id} workspace ${user.workspaceId ?? '-'}`);
		for (const email of unresolved) console.log(`  needs manual review: multiple accounts share ${email}`);

		if (dryRun) return;
		for (const user of phantoms) {
			await users.deleteOne({ _id: user._id });
			if (user.workspaceId) {
				await db.collection('workspaces').updateOne({ _id: user.workspaceId }, { $pull: { userIds: user._id } } as never);
			}
		}
		for (const { user, email } of renames) await users.updateOne({ _id: user._id }, { $set: { email } });
		console.log('Done');
	} finally {
		await client.close();
	}
};

main().catch((error) => {
	console.error('Duplicate user email cleanup failed', error);
	process.exit(1);
});
