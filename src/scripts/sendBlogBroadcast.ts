import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { BroadcastQueueMessage } from '../controllers/newsletter/processBroadcast';
import { listActiveSubscribers, lockBroadcast } from '../utils/newsletter/db';
import { type BlogPostEmailPayload, renderBlogPostEmail, renderConfirmSubscriptionEmail, sendNewsletterEmail } from '../utils/newsletter/emails';
import { createConfirmToken, createUnsubscribeToken, getNewsletterTokenSecret } from '../utils/newsletter/tokens';

interface ParsedArgs {
	slug: string;
	stack: string;
	region: string;
	postFile?: string;
	siteUrl?: string;
	testEmail?: string;
	previewDir?: string;
	dryRun: boolean;
	send: boolean;
}

interface StackConfig {
	subscribersTable: string;
	broadcastsTable: string;
	queueUrl: string;
	configSetName: string;
	apiBaseUrl: string;
	fromAddress: string;
	replyToAddress: string;
	siteBaseUrl: string;
	tokenSecretParam: string;
	physicalAddress?: string;
}

const parseArgs = (argv: string[]): ParsedArgs => {
	const map = new Map<string, string | boolean>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith('--')) {
			map.set(key, true);
		} else {
			map.set(key, next);
			i += 1;
		}
	}

	const slug = String(map.get('slug') ?? '').trim();
	if (!slug) {
		throw new Error('Missing required flag --slug <blog-post-slug>');
	}

	const dryRun = Boolean(map.get('dry-run'));
	const send = Boolean(map.get('send'));
	const testEmail = typeof map.get('test-email') === 'string' ? String(map.get('test-email')).trim() : undefined;
	const previewDir = typeof map.get('preview-dir') === 'string' ? String(map.get('preview-dir')).trim() : undefined;

	if (!dryRun && !send && !testEmail && !previewDir) {
		throw new Error('Specify one of --dry-run, --preview-dir <dir>, --test-email <email>, or --send');
	}
	if (send && (dryRun || testEmail)) {
		throw new Error('Do not combine --send with --dry-run or --test-email');
	}

	return {
		slug,
		stack: typeof map.get('stack') === 'string' ? String(map.get('stack')) : 'uprevit-test',
		region: typeof map.get('region') === 'string' ? String(map.get('region')) : process.env.AWS_REGION || 'us-east-1',
		postFile: typeof map.get('post-file') === 'string' ? String(map.get('post-file')) : undefined,
		siteUrl: typeof map.get('site-url') === 'string' ? String(map.get('site-url')).replace(/\/+$/, '') : undefined,
		testEmail,
		previewDir,
		dryRun,
		send,
	};
};

const stripQuotes = (value: string): string => {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
};

const stripMarkdown = (text: string): string =>
	text
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

const loadBlogPost = (slug: string, siteBaseUrl: string, customPath?: string): BlogPostEmailPayload => {
	const filePath =
		customPath ??
		path.resolve(__dirname, '../../../uprevit-ui/apps/marketing/content/blog', `${slug}.mdx`);
	if (!fs.existsSync(filePath)) {
		throw new Error(`Blog MDX file not found at ${filePath}`);
	}

	const raw = fs.readFileSync(filePath, 'utf8');
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		throw new Error(`Invalid MDX frontmatter in ${filePath}`);
	}

	const frontmatterRaw = match[1];
	const body = match[2];
	const meta: Record<string, string> = {};
	for (const line of frontmatterRaw.split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = stripQuotes(line.slice(idx + 1));
		meta[key] = value;
	}

	const title = meta.title;
	const description = meta.description;
	const date = meta.date;
	const author = meta.author || 'Uprevit Team';
	const category = meta.category || 'Blog';
	if (!title || !description || !date) {
		throw new Error(`Missing required frontmatter (title, description, date) in ${filePath}`);
	}

	const words = body.trim().split(/\s+/).filter(Boolean).length;
	const readTime = `${Math.max(1, Math.round(words / 200))} min read`;

	const paragraphs = body
		.split(/\r?\n\r?\n/)
		.map((block) => block.trim())
		.filter((block) => block && !block.startsWith('#') && !block.startsWith('-') && !block.startsWith('<') && !block.startsWith('import '));
	const firstParagraph = paragraphs[0] ? stripMarkdown(paragraphs[0]) : undefined;
	const excerpt = firstParagraph && firstParagraph.length <= 280 ? firstParagraph : firstParagraph ? `${firstParagraph.slice(0, 250).trim()}...` : undefined;

	return {
		slug,
		title,
		description,
		date,
		author,
		category,
		readTime,
		url: `${siteBaseUrl.replace(/\/+$/, '')}/resources/blogs/${slug}`,
		excerpt,
	};
};

const loadStackConfig = (stack: string, region: string): StackConfig => {
	const raw = execFileSync(
		'aws',
		['cloudformation', 'describe-stacks', '--stack-name', stack, '--region', region, '--output', 'json'],
		{ encoding: 'utf8' },
	);
	const parsed = JSON.parse(raw) as {
		Stacks?: Array<{
			Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
			Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
		}>;
	};
	const stackInfo = parsed.Stacks?.[0];
	if (!stackInfo) {
		throw new Error(`Stack ${stack} not found in ${region}`);
	}

	const outputs = new Map((stackInfo.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
	const params = new Map((stackInfo.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? '']));

	const dbName = params.get('DbName') || 'uprevit-test';
	const defaultSite = dbName === 'uprevit-test' ? 'https://dev.uprevit.com' : 'https://www.uprevit.com';

	return {
		subscribersTable: outputs.get('NewsletterSubscribersTableName') || '',
		broadcastsTable: outputs.get('NewsletterBroadcastsTableName') || '',
		queueUrl: outputs.get('NewsletterBroadcastQueueUrl') || '',
		configSetName: outputs.get('NewsletterConfigurationSetName') || '',
		apiBaseUrl: (outputs.get('ApiBaseUrl') || '').replace(/\/+$/, ''),
		fromAddress: params.get('NewsletterFromAddress') || 'Uprevit Blog <blog@updates.uprevit.com>',
		replyToAddress: params.get('NewsletterReplyToAddress') || 'contact@uprevit.com',
		siteBaseUrl: (params.get('NewsletterSiteBaseUrl') || defaultSite).replace(/\/+$/, ''),
		tokenSecretParam: params.get('NewsletterTokenSecretParam') || '',
		physicalAddress: params.get('NewsletterPhysicalAddress') || undefined,
	};
};

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2));
	const config = loadStackConfig(args.stack, args.region);
	const siteBaseUrl = args.siteUrl || config.siteBaseUrl;

	process.env.AWS_REGION = args.region;
	process.env.NEWSLETTER_SUBSCRIBERS_TABLE = config.subscribersTable;
	process.env.NEWSLETTER_BROADCASTS_TABLE = config.broadcastsTable;
	process.env.NEWSLETTER_TOKEN_SECRET_PARAM = config.tokenSecretParam;

	const post = loadBlogPost(args.slug, siteBaseUrl, args.postFile);

	if (args.previewDir) {
		fs.mkdirSync(args.previewDir, { recursive: true });
		const sampleConfirm = renderConfirmSubscriptionEmail({
			confirmUrl: `${siteBaseUrl}/newsletter/confirm?token=sample-preview-token`,
			siteBaseUrl,
			physicalAddress: config.physicalAddress,
		});
		const sampleBlog = renderBlogPostEmail({
			post,
			unsubscribeUrl: `${siteBaseUrl}/newsletter/unsubscribe?token=sample-preview-token`,
			siteBaseUrl,
			physicalAddress: config.physicalAddress,
		});
		fs.writeFileSync(path.join(args.previewDir, 'confirm-email.html'), sampleConfirm.html, 'utf8');
		fs.writeFileSync(path.join(args.previewDir, 'blog-post-email.html'), sampleBlog.html, 'utf8');
		console.log(`Wrote email previews to ${args.previewDir}`);
		if (!args.dryRun && !args.testEmail && !args.send) return;
	}

	const secret = await getNewsletterTokenSecret();
	if (!secret) {
		throw new Error(`Newsletter token secret missing at SSM parameter: ${config.tokenSecretParam}`);
	}

	if (args.testEmail) {
		const token = createUnsubscribeToken(args.testEmail, secret);
		const encodedToken = encodeURIComponent(token);
		const unsubscribeUrl = `${siteBaseUrl}/newsletter/unsubscribe?token=${encodedToken}`;
		const oneClickUnsubscribeUrl = config.apiBaseUrl
			? `${config.apiBaseUrl}/newsletter/unsubscribe?token=${encodedToken}`
			: undefined;

		const rendered = renderBlogPostEmail({
			post,
			unsubscribeUrl,
			siteBaseUrl,
			physicalAddress: config.physicalAddress,
		});

		await sendNewsletterEmail({
			to: args.testEmail,
			from: config.fromAddress,
			replyTo: config.replyToAddress,
			configurationSetName: config.configSetName,
			email: rendered,
			oneClickUnsubscribeUrl,
		});

		const confirm = createConfirmToken(args.testEmail, secret);
		console.log(
			JSON.stringify(
				{
					mode: 'test-email',
					to: args.testEmail,
					from: config.fromAddress,
					subject: rendered.subject,
					postUrl: post.url,
					unsubscribeUrl,
					sampleConfirmUrl: `${siteBaseUrl}/newsletter/confirm?token=${encodeURIComponent(confirm.token)}`,
				},
				null,
				2,
			),
		);
		return;
	}

	const subscribers = await listActiveSubscribers();

	if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					mode: 'dry-run',
					stack: args.stack,
					slug: post.slug,
					title: post.title,
					url: post.url,
					readTime: post.readTime,
					activeSubscribers: subscribers.length,
				},
				null,
				2,
			),
		);
		return;
	}

	if (subscribers.length === 0) {
		console.log('No active subscribers found. Skipping broadcast.');
		return;
	}

	const locked = await lockBroadcast({
		slug: post.slug,
		title: post.title,
		subject: post.title,
		recipientCount: subscribers.length,
		nowIso: new Date().toISOString(),
	});
	if (!locked) {
		throw new Error(`Broadcast for slug "${post.slug}" was already queued/sent.`);
	}

	const sqs = new SQSClient({ region: args.region });
	let queued = 0;

	for (let i = 0; i < subscribers.length; i += 10) {
		const chunk = subscribers.slice(i, i + 10);
		const response = await sqs.send(
			new SendMessageBatchCommand({
				QueueUrl: config.queueUrl,
				Entries: chunk.map((sub, idx) => {
					const payload: BroadcastQueueMessage = {
						slug: post.slug,
						email: sub.email,
						apiBaseUrl: config.apiBaseUrl,
						siteBaseUrl,
						post,
					};
					return {
						Id: `${i + idx}`,
						MessageBody: JSON.stringify(payload),
					};
				}),
			}),
		);
		queued += (response.Successful ?? []).length;
		if (response.Failed && response.Failed.length > 0) {
			console.error('Some SQS messages failed to enqueue:', response.Failed);
		}
	}

	console.log(
		JSON.stringify(
			{
				mode: 'send',
				stack: args.stack,
				slug: post.slug,
				totalActiveSubscribers: subscribers.length,
				queuedMessages: queued,
			},
			null,
			2,
		),
	);
};

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
