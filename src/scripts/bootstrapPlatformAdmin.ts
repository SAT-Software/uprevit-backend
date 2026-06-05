/* eslint-disable require-jsdoc */
import { MongoClient, ServerApiVersion } from 'mongodb';
import {
	PLATFORM_ADMINS_COLLECTION,
	type PlatformAdmin,
	type PlatformAdminRole,
} from '../models/platformAdmin';

const usage = [
	'Usage:',
	'  npm run bootstrap:platform-admin -- --email you@company.com --cognito-sub <sub> [--name "Your Name"] [--role owner]  (from repo root or src/)',
	'',
	'Required env:',
	'  MONGODB_URI, DB_NAME',
	'',
	'Prerequisites:',
	'  1. Add the user to Cognito group "platform-admin" in AWS Console.',
	'  2. Copy the user\'s Cognito sub from the user pool user details.',
].join('\n');

const parseArgs = () => {
	const args = process.argv.slice(2);
	const getValue = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};

	const email = getValue('--email');
	const cognitoSub = getValue('--cognito-sub');
	const name = getValue('--name');
	const role = (getValue('--role') || 'owner') as PlatformAdminRole;

	if (!email || !cognitoSub) {
		console.error(usage);
		process.exit(1);
	}

	if (!['owner', 'operator', 'viewer'].includes(role)) {
		console.error('--role must be owner, operator, or viewer');
		process.exit(1);
	}

	return {
		email: email.trim().toLowerCase(),
		cognitoSub: cognitoSub.trim(),
		name: name?.trim(),
		role,
		dryRun: args.includes('--dry-run'),
	};
};

const main = async () => {
	const { email, cognitoSub, name, role, dryRun } = parseArgs();
	const uri = process.env.MONGODB_URI;
	const dbName = process.env.DB_NAME;

	if (!uri || !dbName) {
		console.error('MONGODB_URI and DB_NAME are required');
		process.exit(1);
	}

	const client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	const db = client.db(dbName);
	const collection = db.collection<PlatformAdmin>(PLATFORM_ADMINS_COLLECTION);

	const existing = await collection.findOne({
		$or: [{ email }, { cognitoSub }],
	});

	if (existing) {
		console.error('A platform operator already exists for this email or cognitoSub:', existing._id?.toString());
		await client.close();
		process.exit(1);
	}

	const now = new Date();
	const doc: PlatformAdmin = {
		cognitoSub,
		email,
		name,
		status: 'active',
		role,
		createdAt: now,
		updatedAt: now,
	};

	if (dryRun) {
		console.log('[dry-run] Would insert platform operator:', doc);
		await client.close();
		return;
	}

	const result = await collection.insertOne(doc);
	console.log('Created platform operator:', result.insertedId.toString());
	await client.close();
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
