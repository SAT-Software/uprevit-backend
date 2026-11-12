import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;

const { lambdaHandler } = require('../../controllers/docs/consumeDocsChatQuota');

const event = { httpMethod: 'POST', headers: { Authorization: 'Bearer token' }, requestContext: { requestId: 'req-1' } } as unknown as APIGatewayProxyEvent;

describe('consumeDocsChatQuota', () => {
	let counts: Map<string, number>;
	let findOneAndUpdate: jest.Mock<(filter: { _id: string }, update: { $inc: { count: number } }) => Promise<unknown>>;

	beforeEach(() => {
		jest.clearAllMocks();
		counts = new Map();
		findOneAndUpdate = jest.fn(async (filter, update) => {
			const count = (counts.get(filter._id) ?? 0) + update.$inc.count;
			counts.set(filter._id, count);
			return { _id: filter._id, count };
		});
		dbModule.getDb.mockResolvedValue({ collection: jest.fn(() => ({ findOneAndUpdate, createIndex: jest.fn(async () => 'expiresAt_1') })) });
		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { userId: new ObjectId(), workspaceId: new ObjectId() },
		});
	});

	const keyFor = (prefix: string) => [...counts.keys()].find((key) => key.startsWith(prefix))!;

	it('counts a prompt under both limits', async () => {
		const response = await lambdaHandler(event);

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body).result.remaining).toBe(9);
		expect(counts.get(keyFor('user:'))).toBe(1);
		expect(counts.get(keyFor('ws:'))).toBe(1);
	});

	it('rejects the 11th prompt of a user and undoes the increment', async () => {
		for (let i = 0; i < 10; i++) await lambdaHandler(event);

		const response = await lambdaHandler(event);

		expect(response.statusCode).toBe(429);
		expect(counts.get(keyFor('user:'))).toBe(10);
		expect(counts.get(keyFor('ws:'))).toBe(10);
	});

	it('rejects when the workspace is at its limit and undoes both increments', async () => {
		await lambdaHandler(event);
		counts.set(keyFor('ws:'), 50);

		const response = await lambdaHandler(event);

		expect(response.statusCode).toBe(429);
		expect(counts.get(keyFor('ws:'))).toBe(50);
		expect(counts.get(keyFor('user:'))).toBe(1);
	});
});
