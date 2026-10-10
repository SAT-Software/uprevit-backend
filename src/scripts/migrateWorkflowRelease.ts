/* eslint-disable require-jsdoc */
import { execFileSync } from 'child_process';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { backfillProductOwners } from './backfillProductOwners';
import { migrateProductLifecycle } from './migrateProductLifecycle';

/**
 * Runs the 0.8.0 data migrations on a deployed environment: the product lifecycle migration, then the Product Owner
 * backfill. Targets match the GitHub deploy environments, and the MongoDB URI is read from SSM and never printed.
 * It only plans (dry run) unless `--apply` repeats the target database name. Both steps are safe to run twice.
 * A database without products is accepted as an empty environment only after the deployed backend is confirmed to use
 * the same URI and database, and no other database on the cluster differs from it only by case.
 *
 * Usage: AWS_PROFILE=... npm run migrate:workflow-release -- --target prod|demo|dev [--apply <DB_NAME>]
 */

const TARGETS = {
	prod: { dbName: 'Uprevit-prod', uriParam: '/uprevit/prod/backend/MONGODB_URI', stack: 'uprevit-prod' },
	demo: { dbName: 'uprevit-stage', uriParam: '/uprevit/stage/backend/MONGODB_URI', stack: 'uprevit-stage' },
	dev: { dbName: 'uprevit-test', uriParam: '/uprevit/dev/backend/MONGODB_URI', stack: 'uprevit-test' },
} as const;

let mongoUri: string | undefined;

const parseArgs = (args: string[]) => {
	const flags = ['--target', '--apply', '--dry-run'];
	const unknown = args.filter((arg, index) => !flags.includes(arg) && !['--target', '--apply'].includes(args[index - 1]));
	if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
	if (flags.some((flag) => args.filter((arg) => arg === flag).length > 1)) throw new Error('Each flag can be passed once');

	const valueOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
	const targetName = valueOf('--target');
	if (!targetName || !Object.keys(TARGETS).includes(targetName)) throw new Error(`--target must be one of: ${Object.keys(TARGETS).join(', ')}`);
	const target = { name: targetName, ...TARGETS[targetName as keyof typeof TARGETS] };

	const apply = args.includes('--apply');
	if (apply && args.includes('--dry-run')) throw new Error('Pass either --dry-run or --apply, not both');
	if (apply && valueOf('--apply') !== target.dbName) throw new Error(`--apply must repeat the target database name: ${target.dbName}`);
	return { target, dryRun: !apply };
};

const aws = (region: string, args: string[]) =>
	execFileSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const assertDeployedTarget = (target: ReturnType<typeof parseArgs>['target'], region: string) => {
	const functionName = JSON.parse(aws(region, [
		'cloudformation', 'describe-stack-resources', '--stack-name', target.stack,
		'--query', 'StackResources[?ResourceType==`AWS::Lambda::Function`].PhysicalResourceId | [0]',
	]));
	if (!functionName) throw new Error(`Stack ${target.stack} has no Lambda functions`);
	const env = JSON.parse(aws(region, ['lambda', 'get-function-configuration', '--function-name', functionName, '--query', 'Environment.Variables']));
	if (env?.DB_NAME !== target.dbName) throw new Error(`Stack ${target.stack} uses database ${env?.DB_NAME}, not ${target.dbName}`);
	if (env?.MONGODB_URI !== mongoUri) throw new Error(`Stack ${target.stack} uses a different MongoDB URI than ${target.uriParam}`);
};

const main = async () => {
	const { target, dryRun } = parseArgs(process.argv.slice(2));
	if (process.env.MONGODB_URI) throw new Error('Unset MONGODB_URI. This script reads the target URI from SSM.');
	if (process.env.DB_NAME && process.env.DB_NAME !== target.dbName) {
		throw new Error(`DB_NAME is ${process.env.DB_NAME}, but target ${target.name} uses ${target.dbName}`);
	}

	const region = process.env.AWS_REGION ?? 'us-east-1';
	const ssm = new SSMClient({ region });
	const { Parameter } = await ssm.send(new GetParameterCommand({ Name: target.uriParam, WithDecryption: true }));
	mongoUri = Parameter?.Value;
	if (!mongoUri) throw new Error(`SSM parameter ${target.uriParam} is empty`);
	const uriDbName = decodeURIComponent(new URL(mongoUri).pathname.slice(1));
	if (uriDbName && uriDbName !== target.dbName) throw new Error(`The SSM URI for ${target.name} names a different database`);

	const client = new MongoClient(mongoUri, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		const db = client.db(target.dbName);
		console.log(`Target ${target.name} (database ${target.dbName}), ${dryRun ? 'dry run: nothing is written' : 'applying changes'}`);

		if (await db.collection('products').countDocuments({}, { limit: 1 }) === 0) {
			assertDeployedTarget(target, region);
			const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
			const lookalikes = databases.map(({ name }) => name)
				.filter((name) => name !== target.dbName && name.toLowerCase() === target.dbName.toLowerCase());
			if (lookalikes.length) throw new Error(`Database ${target.dbName} has no products, but the cluster also has ${lookalikes.join(', ')}`);
			console.log(`\nDatabase ${target.dbName} has no products, and stack ${target.stack} is deployed against it. Nothing to migrate: 0 updates.`);
			return;
		}

		console.log('\n1/2 Product lifecycle');
		const lifecycleUpdates = await migrateProductLifecycle(db, dryRun);
		console.log('\n2/2 Product Owner backfill');
		await backfillProductOwners(db, dryRun);

		if (dryRun && lifecycleUpdates > 0) {
			console.warn('\n[warn] The lifecycle plan was not applied, so the owner plan above reads versions before they get a lineage.'
				+ ' Its lineage and owner counts are provisional; --apply runs the owner backfill after the lifecycle migration.');
		}
	} finally {
		await client.close();
	}
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error('Workflow release migration failed:', mongoUri ? message.split(mongoUri).join('[redacted]') : message);
	process.exit(1);
});
