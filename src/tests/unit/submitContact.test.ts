import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/email', () => ({
	sendEmail: jest.fn(),
}));

jest.mock('../../utils/ssm', () => ({
	readSecureParameter: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
	logError: jest.fn(),
	logWarn: jest.fn(),
	logInfo: jest.fn(),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const emailModule = jest.requireMock('../../utils/email') as any;
const ssmModule = jest.requireMock('../../utils/ssm') as any;

const { lambdaHandler, resetContactRateLimitIndexFlagForTests } = require('../../controllers/contact/submitContact');

const basePayload = {
	firstName: 'Alex',
	lastName: 'Rivera',
	email: 'alex@northwind.health',
	company: 'Northwind Health',
	topic: 'demo',
	message: 'We manage 40 medical devices and want a walkthrough.',
	turnstileToken: 'valid-turnstile-token',
};

const makeEvent = (overrides: {
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
	sourceIp?: string;
} = {}): APIGatewayProxyEvent => {
	const body = overrides.rawBody !== undefined ? overrides.rawBody : JSON.stringify(overrides.body ?? basePayload);
	return {
		httpMethod: 'POST',
		body,
		headers: overrides.headers ?? { Origin: 'https://uprevit.com' },
		requestContext: {
			requestId: 'req-contact-1',
			identity: { sourceIp: overrides.sourceIp ?? '203.0.113.10' },
		},
	} as unknown as APIGatewayProxyEvent;
};

describe('submitContact', () => {
	const originalEnv = process.env;
	const originalFetch = global.fetch;
	let counts: Map<string, number>;
	let findOneAndUpdate: jest.Mock<(filter: { _id: string }, update: { $inc: { count: number } }) => Promise<unknown>>;
	let createIndex: jest.Mock<() => Promise<string>>;

	beforeEach(() => {
		jest.clearAllMocks();
		resetContactRateLimitIndexFlagForTests();
		process.env = {
			...originalEnv,
			DB_NAME: 'uprevit-prod',
			CONTACT_TO_EMAIL: 'contact@uprevit.com',
			CONTACT_ALLOWED_ORIGINS: 'https://uprevit.com,https://www.uprevit.com',
			TURNSTILE_SECRET_PARAM: '/uprevit/prod/contact/turnstile-secret',
		};

		counts = new Map();
		findOneAndUpdate = jest.fn(async (filter, update) => {
			const count = (counts.get(filter._id) ?? 0) + update.$inc.count;
			counts.set(filter._id, count);
			return { _id: filter._id, count };
		});
		createIndex = jest.fn(async () => 'expiresAt_1');
		dbModule.getDb.mockResolvedValue({ collection: jest.fn(() => ({ findOneAndUpdate, createIndex })) });
		ssmModule.readSecureParameter.mockResolvedValue('test-turnstile-secret');
		emailModule.sendEmail.mockResolvedValue(true);
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

	const keyFor = (prefix: string) => [...counts.keys()].find((key) => key.startsWith(prefix));

	it('verifies Turnstile, counts limits, and sends email with Reply-To', async () => {
		const response = await lambdaHandler(makeEvent());

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ message: 'Message sent' });
		expect(createIndex).toHaveBeenCalledTimes(1);
		expect(ssmModule.readSecureParameter).toHaveBeenCalledWith('/uprevit/prod/contact/turnstile-secret');
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(emailModule.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'contact@uprevit.com',
				replyTo: 'alex@northwind.health',
				subject: '[Book a demo] Northwind Health — Alex Rivera',
				body: 'We manage 40 medical devices and want a walkthrough.',
			}),
		);
		expect(counts.get(keyFor('ip:')!)).toBe(1);
		expect(counts.get(keyFor('email:')!)).toBe(1);
	});

	it('accepts all three valid contact topics', async () => {
		for (const topic of ['demo', 'pricing', 'support'] as const) {
			const response = await lambdaHandler(
				makeEvent({
					body: { ...basePayload, topic, email: `${topic}@northwind.health` },
					sourceIp: `203.0.113.${topic.length}`,
				}),
			);
			expect(response.statusCode).toBe(200);
		}
	});

	it('rejects disallowed or missing origins with 403', async () => {
		const badOrigin = await lambdaHandler(makeEvent({ headers: { Origin: 'https://evil.example' } }));
		expect(badOrigin.statusCode).toBe(403);

		const missingOrigin = await lambdaHandler(makeEvent({ headers: {} }));
		expect(missingOrigin.statusCode).toBe(403);
		expect(emailModule.sendEmail).not.toHaveBeenCalled();
	});

	it('matches allowed origin case-insensitively and falls back to Referer', async () => {
		const withSlash = await lambdaHandler(makeEvent({ headers: { origin: 'HTTPS://WWW.UPREVIT.COM/' } }));
		expect(withSlash.statusCode).toBe(200);

		const withReferer = await lambdaHandler(
			makeEvent({
				headers: { Referer: 'https://uprevit.com/contact?topic=pricing' },
				sourceIp: '203.0.113.11',
			}),
		);
		expect(withReferer.statusCode).toBe(200);
	});

	it('silently accepts honeypot submissions without touching DB, Turnstile, or SES', async () => {
		const response = await lambdaHandler(makeEvent({ body: { ...basePayload, website: 'https://spam.example' } }));

		expect(response.statusCode).toBe(200);
		expect(dbModule.getDb).not.toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
		expect(emailModule.sendEmail).not.toHaveBeenCalled();
	});

	it('validates input fields, body size, and JSON structure', async () => {
		const badJson = await lambdaHandler(makeEvent({ rawBody: '{broken' }));
		expect(badJson.statusCode).toBe(400);

		const oversized = await lambdaHandler(makeEvent({ rawBody: 'x'.repeat(17 * 1024) }));
		expect(oversized.statusCode).toBe(400);

		const badFields = await lambdaHandler(
			makeEvent({
				body: {
					firstName: '',
					lastName: 'Rivera\nInjected',
					email: 'not-an-email',
					company: '',
					topic: 'invalid',
					message: 'a'.repeat(2001),
				},
			}),
		);
		expect(badFields.statusCode).toBe(400);
		const parsed = JSON.parse(badFields.body);
		expect(parsed.errors).toMatchObject({
			firstName: expect.any(String),
			lastName: expect.any(String),
			email: expect.any(String),
			company: expect.any(String),
			topic: expect.any(String),
			message: expect.any(String),
		});

		const protoTopic = await lambdaHandler(makeEvent({ body: { ...basePayload, topic: 'constructor' } }));
		expect(protoTopic.statusCode).toBe(400);
		expect(JSON.parse(protoTopic.body).errors).toMatchObject({ topic: expect.any(String) });
		expect(emailModule.sendEmail).not.toHaveBeenCalled();
	});

	it('rate limits by IP after 3 submissions and rolls back the 4th increment', async () => {
		for (let i = 0; i < 3; i++) {
			const res = await lambdaHandler(makeEvent({ body: { ...basePayload, email: `user${i}@northwind.health` } }));
			expect(res.statusCode).toBe(200);
		}

		const limited = await lambdaHandler(makeEvent({ body: { ...basePayload, email: 'user4@northwind.health' } }));
		expect(limited.statusCode).toBe(429);
		expect(limited.headers?.['Retry-After']).toBeDefined();
		expect(counts.get(keyFor('ip:')!)).toBe(3);
	});

	it('rate limits by normalized email across different IPs and rolls back both counters', async () => {
		for (let i = 0; i < 3; i++) {
			const res = await lambdaHandler(
				makeEvent({
					body: { ...basePayload, email: i === 1 ? 'ALEX@Northwind.Health' : 'alex@northwind.health' },
					sourceIp: `203.0.113.${20 + i}`,
				}),
			);
			expect(res.statusCode).toBe(200);
		}

		const limited = await lambdaHandler(makeEvent({ sourceIp: '203.0.113.99' }));
		expect(limited.statusCode).toBe(429);
		expect(counts.get(keyFor('email:')!)).toBe(3);
		const lastIpKey = [...counts.keys()].filter((k) => k.startsWith('ip:')).pop()!;
		expect(counts.get(lastIpKey)).toBe(0);
	});

	it('handles Turnstile missing token, failed verification, and prod fail-closed', async () => {
		const missingToken = await lambdaHandler(makeEvent({ body: { ...basePayload, turnstileToken: '' } }));
		expect(missingToken.statusCode).toBe(400);
		expect(counts.get(keyFor('ip:')!)).toBe(0);

		global.fetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
		})) as unknown as typeof fetch;

		const failed = await lambdaHandler(makeEvent());
		expect(failed.statusCode).toBe(403);
		expect(counts.get(keyFor('ip:')!)).toBe(1);
		expect(keyFor('email:')).toBeUndefined();

		delete process.env.TURNSTILE_SECRET_PARAM;
		const prodUnconfigured = await lambdaHandler(makeEvent({ sourceIp: '203.0.113.55' }));
		expect(prodUnconfigured.statusCode).toBe(500);
	});

	it('rolls back both rate-limit counters when SES fails', async () => {
		emailModule.sendEmail.mockRejectedValueOnce(new Error('SES timeout'));

		const response = await lambdaHandler(makeEvent());

		expect(response.statusCode).toBe(500);
		expect(counts.get(keyFor('ip:')!)).toBe(0);
		expect(counts.get(keyFor('email:')!)).toBe(0);
	});
});
