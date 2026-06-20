import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

const dbModule = jest.requireMock('../../utils/db') as any;

const {
	bytesToUploadMb,
	ingestExportUsageEvent,
	ingestUploadUsageEvent,
	isChargebeeConfigured,
} = require('../../utils/billing/chargebeeUsageEvents');
const {
	buildChargebeeDeduplicationId,
	trySyncUsageEventToChargebee,
} = require('../../utils/billing/usageEventChargebeeSync');

describe('chargebee usage events', () => {
	const originalFetch = global.fetch;
	const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
	const recentOccurredAt = () => new Date();

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.CHARGEBEE_SITE = 'test-site';
		process.env.CHARGEBEE_API_KEY = 'test-key';
		dbModule.getDb.mockResolvedValue({
			collection: () => ({ updateOne }),
		});
	});

	afterEach(() => {
		global.fetch = originalFetch;
		delete process.env.CHARGEBEE_SITE;
		delete process.env.CHARGEBEE_API_KEY;
	});

	it('detects Chargebee configuration from env', () => {
		expect(isChargebeeConfigured()).toBe(true);
		delete process.env.CHARGEBEE_API_KEY;
		expect(isChargebeeConfigured()).toBe(false);
	});

	it('converts upload bytes to fractional MB', () => {
		expect(bytesToUploadMb(3 * 1024 * 1024)).toBe(3);
		expect(bytesToUploadMb(1024 * 1024)).toBe(1);
		expect(bytesToUploadMb(1024 * 1024 + 1)).toBeCloseTo(1 + 1 / (1024 * 1024));
		expect(bytesToUploadMb(512 * 1024)).toBe(0.5);
	});

	it('builds stable unique Chargebee deduplication IDs within the length limit', () => {
		const firstKey = 'upload:uploads/69174ada552dcbbf657f8/shared-prefix/first.pdf';
		const secondKey = 'upload:uploads/69174ada552dcbbf657f8/shared-prefix/second.pdf';
		const firstId = buildChargebeeDeduplicationId(firstKey);

		expect(firstId).toHaveLength(36);
		expect(firstId).toBe(buildChargebeeDeduplicationId(firstKey));
		expect(firstId).not.toBe(buildChargebeeDeduplicationId(secondKey));
	});

	it('marks export usage events pending_link when subscription is not linked', async () => {
		const eventId = new ObjectId();
		const workspaceId = new ObjectId();
		const accountId = new ObjectId();

		await trySyncUsageEventToChargebee({
			event: {
				_id: eventId,
				workspaceId,
				metric: 'completed_export',
				idempotencyKey: 'export:abc123',
				occurredAt: recentOccurredAt(),
			},
			account: {
				_id: accountId,
				workspaceId,
			},
		});

		expect(updateOne).toHaveBeenCalledWith(
			{ _id: eventId },
			expect.objectContaining({
				$set: expect.objectContaining({
					chargebeeSync: expect.objectContaining({
						status: 'pending_link',
						deduplicationId: buildChargebeeDeduplicationId('export:abc123'),
						attempts: 0,
					}),
				}),
			}),
		);
	});

	it('posts export usage to Chargebee when subscription is linked', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, text: async () => '' }));
		global.fetch = fetchMock as any;

		const eventId = new ObjectId();
		const workspaceId = new ObjectId();
		const accountId = new ObjectId();
		const occurredAt = recentOccurredAt();

		await trySyncUsageEventToChargebee({
			event: {
				_id: eventId,
				workspaceId,
				metric: 'completed_export',
				idempotencyKey: 'export:abc123',
				occurredAt,
			},
			account: {
				_id: accountId,
				workspaceId,
				chargebee: { subscriptionId: 'sub_123' },
			},
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'https://test-site.ingest.chargebee.com/api/v2/usage_events',
			expect.objectContaining({
				method: 'POST',
			}),
		);

		const requestBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body as string);
		expect(requestBody).toEqual({
			deduplication_id: buildChargebeeDeduplicationId('export:abc123'),
			subscription_id: 'sub_123',
			usage_timestamp: occurredAt.getTime(),
			properties: { exports: 1 },
		});
	});

	it('replaces legacy truncated deduplication IDs when retrying', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, text: async () => '' }));
		global.fetch = fetchMock as any;
		const idempotencyKey = 'upload:uploads/69174ada552dcbbf657f8/shared-prefix/file.pdf';

		await trySyncUsageEventToChargebee({
			event: {
				_id: new ObjectId(),
				workspaceId: new ObjectId(),
				metric: 'upload_bytes',
				quantity: 1024 * 1024,
				idempotencyKey,
				occurredAt: recentOccurredAt(),
				chargebeeSync: {
					status: 'failed',
					deduplicationId: idempotencyKey.slice(0, 36),
					attempts: 1,
				},
			},
			account: {
				_id: new ObjectId(),
				workspaceId: new ObjectId(),
				chargebee: { subscriptionId: 'sub_123' },
			},
		});

		const requestBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body as string);
		expect(requestBody.deduplication_id).toBe(buildChargebeeDeduplicationId(idempotencyKey));
	});

	it('posts upload usage to Chargebee with whole upload_mb', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, text: async () => '' }));
		global.fetch = fetchMock as any;

		const eventId = new ObjectId();
		const workspaceId = new ObjectId();
		const accountId = new ObjectId();
		const occurredAt = recentOccurredAt();
		const uploadBytes = 3 * 1024 * 1024;

		await trySyncUsageEventToChargebee({
			event: {
				_id: eventId,
				workspaceId,
				metric: 'upload_bytes',
				quantity: uploadBytes,
				idempotencyKey: 'upload:abc123',
				occurredAt,
			},
			account: {
				_id: accountId,
				workspaceId,
				chargebee: { subscriptionId: 'sub_123' },
			},
		});

		const requestBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body as string);
		expect(requestBody.properties).toEqual({ upload_mb: 3 });
	});

	it('ingestExportUsageEvent throws when Chargebee is not configured', async () => {
		delete process.env.CHARGEBEE_API_KEY;
		await expect(ingestExportUsageEvent({
			subscriptionId: 'sub_123',
			deduplicationId: 'export:abc123',
			usageTimestamp: new Date(),
		})).rejects.toThrow('Chargebee is not configured');
	});

	it('ingestUploadUsageEvent sends upload_mb property', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, text: async () => '' }));
		global.fetch = fetchMock as any;

		await ingestUploadUsageEvent({
			subscriptionId: 'sub_123',
			deduplicationId: 'upload:abc123',
			usageTimestamp: new Date('2026-06-01T00:00:00.000Z'),
			uploadBytes: 5 * 1024 * 1024,
		});

		const requestBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body as string);
		expect(requestBody.properties).toEqual({ upload_mb: 5 });
	});
});
