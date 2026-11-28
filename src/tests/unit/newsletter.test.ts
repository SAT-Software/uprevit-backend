import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent, SNSEvent, SQSEvent } from 'aws-lambda';

jest.mock('../../utils/ssm', () => ({
	readSecureParameter: jest.fn(),
}));

jest.mock('../../utils/newsletter/db', () => ({
	bumpRateLimit: jest.fn(),
	getSubscriber: jest.fn(),
	upsertPendingSubscriber: jest.fn(),
	confirmSubscriber: jest.fn(),
	unsubscribeSubscriber: jest.fn(),
	suppressSubscriber: jest.fn(),
	getBroadcastDelivery: jest.fn(),
	markBroadcastDeliverySent: jest.fn(),
	incrementBroadcastCounter: jest.fn(),
}));

jest.mock('../../utils/newsletter/emails', () => {
	const actual = jest.requireActual('../../utils/newsletter/emails') as Record<string, unknown>;
	return {
		...actual,
		sendNewsletterEmail: jest.fn(),
	};
});

jest.mock('../../utils/logger', () => ({
	logError: jest.fn(),
	logWarn: jest.fn(),
	logInfo: jest.fn(),
}));

const ssmModule = jest.requireMock('../../utils/ssm') as any;
const dbModule = jest.requireMock('../../utils/newsletter/db') as any;
const emailsModule = jest.requireMock('../../utils/newsletter/emails') as any;

const { lambdaHandler: subscribeHandler } = require('../../controllers/newsletter/subscribeNewsletter');
const { lambdaHandler: confirmHandler } = require('../../controllers/newsletter/confirmNewsletter');
const { lambdaHandler: unsubscribeHandler } = require('../../controllers/newsletter/unsubscribeNewsletter');
const { lambdaHandler: broadcastHandler } = require('../../controllers/newsletter/processBroadcast');
const { lambdaHandler: feedbackHandler } = require('../../controllers/newsletter/handleSesFeedback');
const {
	createConfirmToken,
	createUnsubscribeToken,
	sha256Hex,
	verifyNewsletterToken,
} = require('../../utils/newsletter/tokens');
const { renderBlogPostEmail, renderConfirmSubscriptionEmail } = require('../../utils/newsletter/emails');

const TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const makeApiEvent = (overrides: {
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
	queryStringParameters?: Record<string, string>;
	sourceIp?: string;
} = {}): APIGatewayProxyEvent => {
	const body =
		overrides.rawBody !== undefined
			? overrides.rawBody
			: overrides.body !== undefined
				? JSON.stringify(overrides.body)
				: null;
	return {
		httpMethod: 'POST',
		body,
		headers: overrides.headers ?? { Origin: 'https://www.uprevit.com', 'Content-Type': 'application/json' },
		queryStringParameters: overrides.queryStringParameters ?? null,
		requestContext: {
			requestId: 'req-newsletter-1',
			identity: { sourceIp: overrides.sourceIp ?? '203.0.113.10' },
		},
	} as unknown as APIGatewayProxyEvent;
};

describe('newsletter tokens and email templates', () => {
	it('creates and verifies confirm and unsubscribe tokens', () => {
		const now = 1_700_000_000_000;
		const { token } = createConfirmToken('Reader@Example.com', TEST_SECRET, now);
		expect(verifyNewsletterToken(token, 'confirm', TEST_SECRET, now + 1000)).toEqual({
			ok: true,
			email: 'reader@example.com',
		});
		expect(verifyNewsletterToken(token, 'unsubscribe', TEST_SECRET, now + 1000)).toEqual({
			ok: false,
			reason: 'invalid',
		});
		expect(verifyNewsletterToken(token, 'confirm', TEST_SECRET, now + 73 * 60 * 60 * 1000)).toEqual({
			ok: false,
			reason: 'expired',
		});

		const unsubToken = createUnsubscribeToken('Reader@Example.com', TEST_SECRET);
		expect(verifyNewsletterToken(unsubToken, 'unsubscribe', TEST_SECRET)).toEqual({
			ok: true,
			email: 'reader@example.com',
		});
		expect(verifyNewsletterToken(`${unsubToken}x`, 'unsubscribe', TEST_SECRET)).toEqual({
			ok: false,
			reason: 'invalid',
		});
	});

	it('renders clean HTML and plain-text emails with light/dark logos, neutral badges, and highlights', () => {
		const confirm = renderConfirmSubscriptionEmail({
			confirmUrl: 'https://www.uprevit.com/newsletter/confirm?token=abc',
			siteBaseUrl: 'http://localhost:3001',
			physicalAddress: 'Uprevit Inc., 123 Main St',
		});
		expect(confirm.html).toContain('email/uprevit-logo-light.png');
		expect(confirm.html).toContain('email/uprevit-logo-dark.png');
		expect(confirm.html).toContain('prefers-color-scheme: dark');
		expect(confirm.html).toContain('One quick step');
		expect(confirm.html).toContain('72 hours');
		expect(confirm.html).toContain('Confirm subscription');
		expect(confirm.html).toContain('Uprevit Inc., 123 Main St');
		expect(confirm.text).toContain('72 hours');
		expect(confirm.text).toContain('https://www.uprevit.com/newsletter/confirm?token=abc');

		const blog = renderBlogPostEmail({
			post: {
				slug: 'fda-qmsr',
				title: 'FDA QMSR <Updates>',
				description: 'What changes for labeling teams.',
				date: '2026-11-27',
				author: 'Uprevit Team',
				category: 'Regulatory',
				readTime: '5 min read',
				url: 'https://www.uprevit.com/resources/blogs/fda-qmsr',
				highlights: ['What QMSR actually changed', 'The labeling rule FDA kept'],
			},
			unsubscribeUrl: 'https://www.uprevit.com/newsletter/unsubscribe?token=xyz',
			siteBaseUrl: 'https://www.uprevit.com',
		});
		expect(blog.html).toContain('FDA QMSR &lt;Updates&gt;');
		expect(blog.html).toContain('In this post');
		expect(blog.html).toContain('What QMSR actually changed');
		expect(blog.html).toContain('Read the full post');
		expect(blog.html).toContain('https://www.uprevit.com/newsletter/unsubscribe?token=xyz');
		expect(blog.text).toContain('- What QMSR actually changed');
		expect(blog.text).toContain('Unsubscribe: https://www.uprevit.com/newsletter/unsubscribe?token=xyz');
	});
});

describe('newsletter controllers', () => {
	const originalEnv = process.env;
	const originalFetch = global.fetch;
	let counts: Map<string, number>;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = {
			...originalEnv,
			DB_NAME: 'uprevit-prod',
			NEWSLETTER_FROM_ADDRESS: 'Uprevit Blog <blog@updates.uprevit.com>',
			NEWSLETTER_REPLY_TO_ADDRESS: 'contact@uprevit.com',
			NEWSLETTER_SITE_BASE_URL: 'https://www.uprevit.com',
			NEWSLETTER_API_BASE_URL: 'https://api.example.com/Prod',
			NEWSLETTER_ALLOWED_ORIGINS: 'https://www.uprevit.com,https://uprevit.com',
			NEWSLETTER_TURNSTILE_SECRET_PARAM: '/uprevit/prod/newsletter/turnstile-secret',
			NEWSLETTER_TOKEN_SECRET_PARAM: '/uprevit/prod/newsletter/token-secret',
			NEWSLETTER_CONFIGURATION_SET: 'uprevit-prod-newsletter',
		};

		counts = new Map();
		dbModule.bumpRateLimit.mockImplementation(async (pk: string, delta: 1 | -1) => {
			const next = (counts.get(pk) ?? 0) + delta;
			counts.set(pk, next);
			return next;
		});
		dbModule.getSubscriber.mockResolvedValue(null);
		dbModule.upsertPendingSubscriber.mockResolvedValue(true);
		dbModule.confirmSubscriber.mockResolvedValue(true);
		dbModule.unsubscribeSubscriber.mockResolvedValue(undefined);
		dbModule.suppressSubscriber.mockResolvedValue(undefined);
		dbModule.getBroadcastDelivery.mockResolvedValue(null);
		dbModule.markBroadcastDeliverySent.mockResolvedValue(true);
		dbModule.incrementBroadcastCounter.mockResolvedValue(undefined);
		emailsModule.sendNewsletterEmail.mockResolvedValue(undefined);

		ssmModule.readSecureParameter.mockImplementation(async (name: string) => {
			if (name.includes('turnstile')) return 'turnstile-secret';
			if (name.includes('token')) return TEST_SECRET;
			return '';
		});

		global.fetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ success: true }),
		})) as unknown as typeof fetch;
	});

	afterEach(() => {
		process.env = originalEnv;
		global.fetch = originalFetch;
	});

	it('subscribes a new email with Turnstile, stores pending token, and sends confirmation email', async () => {
		const res = await subscribeHandler(
			makeApiEvent({
				body: { email: 'Reader@Company.com', turnstileToken: 'valid-token' },
			}),
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ message: 'Check your inbox to confirm your subscription.' });
		expect(dbModule.upsertPendingSubscriber).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'reader@company.com',
				confirmTokenHash: expect.any(String),
			}),
		);
		expect(emailsModule.sendNewsletterEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'reader@company.com',
				from: 'Uprevit Blog <blog@updates.uprevit.com>',
				configurationSetName: 'uprevit-prod-newsletter',
			}),
		);
	});

	it('silently accepts honeypot, already subscribed, and suppressed emails without sending', async () => {
		const hp = await subscribeHandler(
			makeApiEvent({ body: { email: 'bot@example.com', website: 'https://spam.invalid', turnstileToken: 't' } }),
		);
		expect(hp.statusCode).toBe(200);
		expect(dbModule.bumpRateLimit).not.toHaveBeenCalled();

		dbModule.getSubscriber.mockResolvedValueOnce({ email: 'active@company.com', status: 'subscribed' });
		const activeRes = await subscribeHandler(
			makeApiEvent({ body: { email: 'active@company.com', turnstileToken: 't' } }),
		);
		expect(activeRes.statusCode).toBe(200);
		expect(emailsModule.sendNewsletterEmail).not.toHaveBeenCalled();

		dbModule.getSubscriber.mockResolvedValueOnce({ email: 'bad@company.com', status: 'complained' });
		const suppressedRes = await subscribeHandler(
			makeApiEvent({ body: { email: 'bad@company.com', turnstileToken: 't' }, sourceIp: '203.0.113.11' }),
		);
		expect(suppressedRes.statusCode).toBe(200);
		expect(emailsModule.sendNewsletterEmail).not.toHaveBeenCalled();
	});

	it('rejects disallowed origin and enforces IP and email rate limits with rollback', async () => {
		const badOrigin = await subscribeHandler(
			makeApiEvent({
				body: { email: 'a@company.com', turnstileToken: 't' },
				headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
			}),
		);
		expect(badOrigin.statusCode).toBe(403);

		for (let i = 0; i < 2; i++) {
			const ok = await subscribeHandler(
				makeApiEvent({ body: { email: 'same@company.com', turnstileToken: 't' }, sourceIp: `203.0.113.${30 + i}` }),
			);
			expect(ok.statusCode).toBe(200);
		}
		const limited = await subscribeHandler(
			makeApiEvent({ body: { email: 'same@company.com', turnstileToken: 't' }, sourceIp: '203.0.113.99' }),
		);
		expect(limited.statusCode).toBe(429);
		expect(limited.headers?.['Retry-After']).toBeDefined();
	});

	it('confirms pending subscriber with matching single-use token and rejects invalid/expired tokens', async () => {
		const { token, tokenHash, expiresAt } = createConfirmToken('reader@company.com', TEST_SECRET);
		dbModule.getSubscriber.mockResolvedValueOnce({
			email: 'reader@company.com',
			status: 'pending',
			confirmTokenHash: tokenHash,
			confirmTokenExpiresAt: expiresAt,
		});

		const res = await confirmHandler(makeApiEvent({ body: { token } }));
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).status).toBe('confirmed');
		expect(dbModule.confirmSubscriber).toHaveBeenCalledWith('reader@company.com', tokenHash, expect.any(String));

		dbModule.getSubscriber
			.mockResolvedValueOnce({
				email: 'reader@company.com',
				status: 'pending',
				confirmTokenHash: tokenHash,
				confirmTokenExpiresAt: expiresAt,
			})
			.mockResolvedValueOnce({
				email: 'reader@company.com',
				status: 'unsubscribed',
			});
		dbModule.confirmSubscriber.mockResolvedValueOnce(false);
		const racedUnsub = await confirmHandler(makeApiEvent({ body: { token } }));
		expect(racedUnsub.statusCode).toBe(400);

		dbModule.getSubscriber.mockResolvedValueOnce({
			email: 'reader@company.com',
			status: 'pending',
			confirmTokenHash: sha256Hex('different-token'),
			confirmTokenExpiresAt: expiresAt,
		});
		const mismatch = await confirmHandler(makeApiEvent({ body: { token } }));
		expect(mismatch.statusCode).toBe(400);
	});

	it('handles both browser JSON unsubscribe and RFC 8058 one-click POST without Origin', async () => {
		const unsubToken = createUnsubscribeToken('reader@company.com', TEST_SECRET);

		const browserRes = await unsubscribeHandler(makeApiEvent({ body: { token: unsubToken } }));
		expect(browserRes.statusCode).toBe(200);
		expect(dbModule.unsubscribeSubscriber).toHaveBeenCalledWith('reader@company.com', expect.any(String));

		const oneClickRes = await unsubscribeHandler(
			makeApiEvent({
				rawBody: 'List-Unsubscribe=One-Click',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				queryStringParameters: { token: unsubToken },
			}),
		);
		expect(oneClickRes.statusCode).toBe(200);
		expect(dbModule.unsubscribeSubscriber).toHaveBeenCalledTimes(2);
	});

	it('processes SQS broadcast records, skips already-sent and inactive subscribers, and reports partial failures', async () => {
		dbModule.getBroadcastDelivery
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ slug: 'delivery#what-is-uprevit#already@company.com', status: 'sent' })
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		dbModule.getSubscriber
			.mockResolvedValueOnce({ email: 'active@company.com', status: 'subscribed' })
			.mockResolvedValueOnce({ email: 'left@company.com', status: 'unsubscribed' })
			.mockResolvedValueOnce({ email: 'retry@company.com', status: 'subscribed' });
		emailsModule.sendNewsletterEmail
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('SES throttled'));

		const post = {
			slug: 'what-is-uprevit',
			title: 'What is Uprevit?',
			description: 'Overview post',
			date: '2026-11-12',
			author: 'Uprevit Team',
			category: 'Product',
			readTime: '4 min read',
			url: 'https://www.uprevit.com/resources/blogs/what-is-uprevit',
		};

		const sqsEvent = {
			Records: [
				{ messageId: 'm1', body: JSON.stringify({ slug: post.slug, email: 'active@company.com', post }) },
				{ messageId: 'm-dup', body: JSON.stringify({ slug: post.slug, email: 'already@company.com', post }) },
				{ messageId: 'm2', body: JSON.stringify({ slug: post.slug, email: 'left@company.com', post }) },
				{ messageId: 'm3', body: JSON.stringify({ slug: post.slug, email: 'retry@company.com', post }) },
			],
		} as unknown as SQSEvent;

		const result = await broadcastHandler(sqsEvent);
		expect(emailsModule.sendNewsletterEmail).toHaveBeenCalledTimes(2);
		expect(dbModule.markBroadcastDeliverySent).toHaveBeenCalledWith('what-is-uprevit', 'active@company.com', expect.any(String));
		expect(emailsModule.sendNewsletterEmail).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				to: 'active@company.com',
				oneClickUnsubscribeUrl: expect.stringContaining('https://api.example.com/Prod/newsletter/unsubscribe?token='),
			}),
		);
		expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm3' }] });
	});

	it('defers remaining broadcast records when Lambda remaining time is low', async () => {
		const post = {
			slug: 'what-is-uprevit',
			title: 'What is Uprevit?',
			description: 'Overview post',
			date: '2026-11-12',
			author: 'Uprevit Team',
			category: 'Product',
			readTime: '4 min read',
			url: 'https://www.uprevit.com/resources/blogs/what-is-uprevit',
		};
		const sqsEvent = {
			Records: [
				{ messageId: 'm1', body: JSON.stringify({ slug: post.slug, email: 'a@company.com', post }) },
				{ messageId: 'm2', body: JSON.stringify({ slug: post.slug, email: 'b@company.com', post }) },
			],
		} as unknown as SQSEvent;

		const result = await broadcastHandler(sqsEvent, { getRemainingTimeInMillis: () => 10_000 });
		expect(emailsModule.sendNewsletterEmail).not.toHaveBeenCalled();
		expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }] });
	});

	it('suppresses permanent bounces and complaints from SES SNS feedback and throws on persistence failure', async () => {
		const snsEvent = {
			Records: [
				{
					Sns: {
						MessageId: 's1',
						Message: JSON.stringify({
							eventType: 'Bounce',
							bounce: {
								bounceType: 'Permanent',
								bounceSubType: 'General',
								bouncedRecipients: [{ emailAddress: 'HardBounce@Example.com' }],
							},
						}),
					},
				},
				{
					Sns: {
						MessageId: 's2',
						Message: JSON.stringify({
							eventType: 'Bounce',
							bounce: {
								bounceType: 'Transient',
								bouncedRecipients: [{ emailAddress: 'soft@example.com' }],
							},
						}),
					},
				},
				{
					Sns: {
						MessageId: 's3',
						Message: JSON.stringify({
							eventType: 'Complaint',
							complaint: {
								complaintFeedbackType: 'abuse',
								complainedRecipients: [{ emailAddress: 'Complainer@Example.com' }],
							},
						}),
					},
				},
			],
		} as unknown as SNSEvent;

		await feedbackHandler(snsEvent);
		expect(dbModule.suppressSubscriber).toHaveBeenCalledTimes(2);
		expect(dbModule.suppressSubscriber).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ email: 'hardbounce@example.com', status: 'bounced' }),
		);
		expect(dbModule.suppressSubscriber).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ email: 'complainer@example.com', status: 'complained' }),
		);

		dbModule.suppressSubscriber.mockRejectedValueOnce(new Error('DynamoDB throttled'));
		await expect(feedbackHandler(snsEvent)).rejects.toThrow('Failed to persist 1 SES feedback suppression update(s).');
	});
});
