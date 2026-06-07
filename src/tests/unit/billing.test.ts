import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

const dbModule = jest.requireMock('../../utils/db') as any;

const defaultCollectionFallback = () => ({
	countDocuments: jest.fn(async () => 0),
	createIndex: jest.fn(async () => undefined),
	findOne: jest.fn(async () => null),
	find: jest.fn(() => ({ toArray: jest.fn(async () => []) })),
});

const {
	assertSeatActivationAllowed,
	assertUsageActionAllowed,
	checkMetricLimit,
	isWorkspaceAccessFrozen,
	isWorkspaceUsageFrozen,
	verifySeatLimitAfterActivation,
} = require('../../utils/billing/enforcement');
const {
	bytesToGb,
	gbToBytes,
	addUtcMonths,
	calendarMonthKey,
	computeBillingPeriodFromAnchor,
	defaultPeriodForCadence,
	endOfBillingPeriod,
	resolveBillingPeriod,
} = require('../../utils/billing/billingPeriod');
const { createBillingAccountForWorkspace, DEFAULT_INCLUDED_LIMITS, getBillingAccountByWorkspaceId } = require('../../utils/billing/billingAccounts');
const {
	assertNewUploadCommitsAllowed,
	collectUploadCommitsFromValue,
	isNewUploadKey,
	normalizeSizeBytes,
	recordCommittedUploadBytes,
	recordCommittedUploadIfNew,
	sumNewUploadCommitBytes,
} = require('../../utils/billing/uploadCommit');
const { aggregateUploadReconciliationBreakdown } = require('../../utils/billing/usageRecording');
const { recordUsageEvent } = require('../../utils/billing/usageRecording');
const { buildBillingSummary } = require('../../utils/billing/serializers');

describe('billing period helpers', () => {
	it('converts bytes and gb', () => {
		expect(bytesToGb(gbToBytes(2))).toBeCloseTo(2);
	});

	it('builds calendar month keys', () => {
		expect(calendarMonthKey(new Date('2026-03-15T00:00:00.000Z'))).toBe('2026-03');
	});

	it('anchors monthly periods to account creation time', () => {
		const anchor = new Date('2026-06-06T10:30:00.000Z');
		const now = new Date('2026-06-20T12:00:00.000Z');
		const { periodStart, periodEnd } = computeBillingPeriodFromAnchor(anchor, 'monthly', now);

		expect(periodStart.toISOString()).toBe(anchor.toISOString());
		expect(periodEnd.toISOString()).toBe('2026-07-06T10:29:59.999Z');
	});

	it('rolls monthly periods forward from the anchor', () => {
		const anchor = new Date('2026-06-06T10:30:00.000Z');
		const now = new Date('2026-08-01T00:00:00.000Z');
		const { periodStart, periodEnd } = computeBillingPeriodFromAnchor(anchor, 'monthly', now);

		expect(periodStart.toISOString()).toBe('2026-07-06T10:30:00.000Z');
		expect(periodEnd.toISOString()).toBe('2026-08-06T10:29:59.999Z');
	});

	it('creates default monthly periods from the creation timestamp', () => {
		const now = new Date('2026-06-06T10:30:00.000Z');
		const { periodStart, periodEnd } = defaultPeriodForCadence('monthly', now);

		expect(periodStart.toISOString()).toBe(now.toISOString());
		expect(periodEnd.toISOString()).toBe(endOfBillingPeriod(now, 'monthly').toISOString());
	});

	it('resolves the current period from stored anchor and createdAt fallback', () => {
		const createdAt = new Date('2026-06-06T10:30:00.000Z');
		const now = new Date('2026-06-20T12:00:00.000Z');

		const fromAnchor = resolveBillingPeriod({
			billingCadence: 'monthly',
			periodStart: createdAt,
			periodEnd: new Date('2026-07-01T00:00:00.000Z'),
			createdAt,
		}, now);
		const fromCreatedAt = resolveBillingPeriod({
			billingCadence: 'monthly',
			createdAt,
		}, now);

		expect(fromAnchor.periodStart.toISOString()).toBe(createdAt.toISOString());
		expect(fromCreatedAt.periodStart.toISOString()).toBe(createdAt.toISOString());
	});

	it('clamps month-end anchors when advancing monthly periods', () => {
		const jan31 = new Date('2026-01-31T12:00:00.000Z');
		const febAnchor = addUtcMonths(jan31, 1);
		const mar31 = new Date('2026-03-31T12:00:00.000Z');
		const aprAnchor = addUtcMonths(mar31, 1);

		expect(febAnchor.toISOString()).toBe('2026-02-28T12:00:00.000Z');
		expect(aprAnchor.toISOString()).toBe('2026-04-30T12:00:00.000Z');
	});

	it('advances monthly periods from a Jan 31 anchor without skipping February', () => {
		const anchor = new Date('2026-01-31T12:00:00.000Z');
		const now = new Date('2026-03-15T12:00:00.000Z');
		const { periodStart, periodEnd } = computeBillingPeriodFromAnchor(anchor, 'monthly', now);

		expect(periodStart.toISOString()).toBe('2026-02-28T12:00:00.000Z');
		expect(periodEnd.toISOString()).toBe('2026-03-28T11:59:59.999Z');
	});
});

describe('workspace freezes', () => {
	it('detects access and usage freezes independently', () => {
		expect(isWorkspaceAccessFrozen({ workspaceAccessFreeze: { enabled: true, updatedAt: new Date() } } as any)).toBe(true);
		expect(isWorkspaceUsageFrozen({ workspaceUsageFreeze: { enabled: true, updatedAt: new Date() } } as any)).toBe(true);
		expect(isWorkspaceAccessFrozen({} as any)).toBe(false);
	});
});

describe('metric enforcement', () => {
	const workspaceId = new ObjectId();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('allows usage when metering is disabled', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: false,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							included: DEFAULT_INCLUDED_LIMITS,
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({ toArray: jest.fn(async () => [{ metric: 'completed_export', quantity: 999 }]) })),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				if (name === 'billingAddOnEvents') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne: jest.fn(async () => null),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await checkMetricLimit(workspaceId, 'completed_export');
		expect(result.allowed).toBe(true);
		expect(result.meteringEnabled).toBe(false);
	});

	it('blocks only the exceeded metric when enforcement is block', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							included: { seatMonths: 1, exports: 1, uploadGb: 1, sso: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [
								{ metric: 'completed_export', quantity: 1 },
								{ metric: 'upload_bytes', quantity: 0 },
							]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				if (name === 'billingAddOnEvents') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne: jest.fn(async () => null),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const exportResult = await checkMetricLimit(workspaceId, 'completed_export', 1);
		const uploadResult = await checkMetricLimit(workspaceId, 'upload_bytes', 1);

		expect(exportResult.allowed).toBe(false);
		expect(uploadResult.allowed).toBe(true);
	});

	it('blocks a new export when completed exports are already at the limit', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'workspaces') {
					return {
						findOne: jest.fn(async () => ({ _id: workspaceId })),
					};
				}
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							usageLimits: { seats: 5, exports: 5, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [
								{ metric: 'completed_export', quantity: 5 },
							]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 1),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await assertUsageActionAllowed(workspaceId, 'export');

		expect(result.allowed).toBe(false);
	});

	it('blocks a new export when completed and queued exports reach the limit', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							periodStart: new Date('2026-06-01T00:00:00.000Z'),
							periodEnd: new Date('2026-06-30T23:59:59.999Z'),
							createdAt: new Date('2026-06-01T00:00:00.000Z'),
							workspacePreferences: { enforcementMode: 'block' },
							usageLimits: { seats: 5, exports: 5, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [
								{ metric: 'completed_export', quantity: 3 },
							]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'exportJobs') {
					return {
						countDocuments: jest.fn(async () => 3),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await checkMetricLimit(workspaceId, 'completed_export', 1);

		expect(result.allowed).toBe(false);
		expect(result.used).toBe(6);
	});

	it('does not block workspace-member invites at the seat limit', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'workspaces') {
					return {
						findOne: jest.fn(async () => ({ _id: workspaceId })),
					};
				}
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							included: { seatMonths: 2, exports: 10, uploadGb: 10, sso: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [
								{ metric: 'activated_seat_month', quantity: 2 },
							]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'billingAddOnEvents') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne: jest.fn(async () => null),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const atLimit = await assertUsageActionAllowed(workspaceId, 'invite', 1);
		const underLimit = await assertUsageActionAllowed(workspaceId, 'invite', 0);

		expect(atLimit.allowed).toBe(true);
		expect(underLimit.allowed).toBe(true);
	});

	it('blocks activation at the active-seat limit in block mode', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'workspaces') {
					return {
						findOne: jest.fn(async () => ({ _id: workspaceId })),
					};
				}
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							usageLimits: { seats: 2, exports: 10, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 2),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await assertSeatActivationAllowed(workspaceId, 1);

		expect(result.allowed).toBe(false);
	});

	it('allows activation over the active-seat limit in overage mode', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'workspaces') {
					return {
						findOne: jest.fn(async () => ({ _id: workspaceId })),
					};
				}
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'overage' },
							usageLimits: { seats: 2, exports: 10, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 2),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await assertSeatActivationAllowed(workspaceId, 1);

		expect(result.allowed).toBe(true);
	});

	it('bypasses active-seat activation limits when limits are disabled', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'workspaces') {
					return {
						findOne: jest.fn(async () => ({ _id: workspaceId })),
					};
				}
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: false,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							usageLimits: { seats: 2, exports: 10, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 2),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await assertSeatActivationAllowed(workspaceId, 1);

		expect(result.allowed).toBe(true);
	});

	it('allows replacement activation after an active member is removed', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'workspaces') {
					return {
						findOne: jest.fn(async () => ({ _id: workspaceId })),
					};
				}
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							usageLimits: { seats: 5, exports: 10, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 4),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await assertSeatActivationAllowed(workspaceId, 1);

		expect(result.allowed).toBe(true);
	});

	it('rejects post-activation verification when concurrent activations exceed the seat limit', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							usageLimits: { seats: 1, exports: 10, uploadGb: 10, ssoAllowed: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 2),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await verifySeatLimitAfterActivation(workspaceId);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('Seat limit reached');
	});

	it('enforces legacy-only included limits for export checks', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'billingAccounts') {
					return {
						findOne: jest.fn(async () => ({
							_id: new ObjectId(),
							workspaceId,
							meteringEnabled: true,
							billingCadence: 'monthly',
							createdAt: new Date(),
							workspacePreferences: { enforcementMode: 'block' },
							included: { seatMonths: 5, exports: 1, uploadGb: 10, sso: false },
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [{ metric: 'completed_export', quantity: 1 }]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				return defaultCollectionFallback();
			}),
		});

		const result = await checkMetricLimit(workspaceId, 'completed_export', 1);

		expect(result.allowed).toBe(false);
	});
});

describe('billing account creation', () => {
	it('creates a draft billing account with defaults', async () => {
		const workspaceId = new ObjectId();
		const insertedId = new ObjectId();

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({
				findOne: jest.fn(async () => null),
				insertOne: jest.fn(async (doc: Record<string, unknown>) => {
					expect(doc.status).toBe('draft');
					expect(doc.meteringEnabled).toBe(false);
					return { insertedId };
				}),
				createIndex: jest.fn(async () => undefined),
			})),
		});

		const account = await createBillingAccountForWorkspace(workspaceId);
		expect(account._id?.toString()).toBe(insertedId.toString());
		expect(account.usageLimits?.seats).toBe(DEFAULT_INCLUDED_LIMITS.seatMonths);
		expect(account.included.seatMonths).toBe(DEFAULT_INCLUDED_LIMITS.seatMonths);
	});
});

describe('upload commit helpers', () => {
	const workspaceId = new ObjectId();
	const billingAccountId = new ObjectId();
	let getAccountSpy: jest.SpiedFunction<typeof getBillingAccountByWorkspaceId>;
	let recordUsageSpy: jest.SpiedFunction<typeof recordUsageEvent>;

	beforeEach(() => {
		getAccountSpy = jest.spyOn(
			require('../../utils/billing/billingAccounts'),
			'getBillingAccountByWorkspaceId',
		).mockResolvedValue({
			_id: billingAccountId,
			workspaceId,
			billingCadence: 'monthly',
			createdAt: new Date(),
		} as any);
		recordUsageSpy = jest.spyOn(
			require('../../utils/billing/usageRecording'),
			'recordUsageEvent',
		).mockResolvedValue(null);
	});

	afterEach(() => {
		getAccountSpy.mockRestore();
		recordUsageSpy.mockRestore();
	});

	it('normalizes size bytes', () => {
		expect(normalizeSizeBytes(1024)).toBe(1024);
		expect(normalizeSizeBytes(0)).toBeUndefined();
		expect(normalizeSizeBytes(-1)).toBeUndefined();
	});

	it('detects new upload keys', () => {
		expect(isNewUploadKey('', 'uploads/ws/file.png')).toBe(true);
		expect(isNewUploadKey('uploads/ws/file.png', 'uploads/ws/file.png')).toBe(false);
		expect(isNewUploadKey('uploads/ws/old.png', 'uploads/ws/new.png')).toBe(true);
	});

	it('collects upload commits from nested payloads', () => {
		const commits = collectUploadCommitsFromValue([
			{ key: 'uploads/ws/product/a.png', sizeBytes: 100 },
			{ tagged_image_key: 'uploads/ws/product/tagged.png', sizeBytes: 250 },
		]);

		expect(commits).toEqual([
			{ key: 'uploads/ws/product/a.png', sizeBytes: 100 },
			{ key: 'uploads/ws/product/tagged.png', sizeBytes: 250 },
		]);
	});

	it('records committed upload bytes with S3 key idempotency', async () => {
		await recordCommittedUploadBytes({
			workspaceId,
			uploadKey: 'uploads/ws/source-files/doc.pdf',
			sizeBytes: 4096,
		});

		expect(recordUsageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				metric: 'upload_bytes',
				quantity: 4096,
				sourceId: 'uploads/ws/source-files/doc.pdf',
				idempotencyKey: 'upload:uploads/ws/source-files/doc.pdf',
			}),
		);
	});

	it('skips recording when asset key is unchanged', async () => {
		await recordCommittedUploadIfNew({
			workspaceId,
			previousKey: 'uploads/ws/logo.png',
			newKey: 'uploads/ws/logo.png',
			sizeBytes: 2048,
		});

		expect(recordUsageSpy).not.toHaveBeenCalled();
	});

	it('sums only upload commits that have not been recorded yet', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({
				findOne: jest.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => (
					idempotencyKey === 'upload:uploads/ws/product/existing.png'
						? { idempotencyKey }
						: null
				)),
			})),
		});

		const total = await sumNewUploadCommitBytes(workspaceId, [
			{ key: 'uploads/ws/product/existing.png', sizeBytes: 100 },
			{ key: 'uploads/ws/product/new.png', sizeBytes: 250 },
		]);

		expect(total).toBe(250);
	});

	it('blocks new upload commits that would exceed the limit', async () => {
		const getAccountSpy = jest.spyOn(
			require('../../utils/billing/billingAccounts'),
			'getBillingAccountByWorkspaceId',
		).mockResolvedValue({
			_id: billingAccountId,
			workspaceId,
			meteringEnabled: true,
			billingCadence: 'monthly',
			createdAt: new Date(),
			workspacePreferences: { enforcementMode: 'block' },
			included: { seatMonths: 1, exports: 1, uploadGb: 0.001, sso: false },
		} as any);

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'usageEvents') {
					return {
						findOne: jest.fn(async () => null),
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [
								{ metric: 'upload_bytes', quantity: gbToBytes(0.001) - 1 },
							]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'billingAddOnEvents') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne: jest.fn(async () => null),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				return {
					findOne: jest.fn(async () => null),
				};
			}),
		});

		const result = await assertNewUploadCommitsAllowed(workspaceId, [
			{ key: 'uploads/ws/product/new.png', sizeBytes: 2048 },
		]);

		expect(result.allowed).toBe(false);
		getAccountSpy.mockRestore();
	});

	it('records when asset key changes', async () => {
		await recordCommittedUploadIfNew({
			workspaceId,
			previousKey: 'uploads/ws/logo-old.png',
			newKey: 'uploads/ws/logo-new.png',
			sizeBytes: 2048,
		});

		expect(recordUsageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				quantity: 2048,
				idempotencyKey: 'upload:uploads/ws/logo-new.png',
			}),
		);
	});
});

describe('upload reconciliation breakdown', () => {
	const workspaceId = new ObjectId();
	const periodStart = new Date('2026-06-01T00:00:00.000Z');
	const periodEnd = new Date('2026-06-30T23:59:59.999Z');

	it('separates upload commit bytes from platform adjustments', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({
				find: jest.fn(() => ({
					toArray: jest.fn(async () => [
						{
							metric: 'upload_bytes',
							source: 'upload_commit',
							quantity: 1000,
						},
						{
							metric: 'upload_bytes',
							source: 'platform_adjustment',
							quantity: 200,
						},
					]),
				})),
				createIndex: jest.fn(async () => undefined),
			})),
		});

		const breakdown = await aggregateUploadReconciliationBreakdown({
			workspaceId,
			periodStart,
			periodEnd,
		});

		expect(breakdown.commitBytes).toBe(1000);
		expect(breakdown.adjustmentBytes).toBe(200);
		expect(breakdown.totalBytes).toBe(1200);
	});
});

describe('usage snapshots', () => {
	const workspaceId = new ObjectId();
	const billingAccountId = new ObjectId();
	const periodStart = new Date('2026-06-01T00:00:00.000Z');
	const periodEnd = new Date('2026-06-30T23:59:59.999Z');
	const billingAccount = {
		_id: billingAccountId,
		workspaceId,
		status: 'active',
		meteringEnabled: true,
		billingCadence: 'monthly',
		currency: 'USD',
		netTermDays: 30,
		paymentMode: 'offline_wire',
		periodStart,
		periodEnd,
		createdAt: periodStart,
		updatedAt: periodStart,
		usageLimits: { seats: 5, exports: 100, uploadGb: 10, ssoAllowed: false },
		included: { seatMonths: 5, exports: 100, uploadGb: 10, sso: false },
		workspacePreferences: { enforcementMode: 'block' },
		sso: { enabled: false },
		pastDue: false,
	};

	const { getCurrentUsageSnapshot, recomputeUsageSnapshot } = require('../../utils/billing/snapshots');

	beforeEach(() => {
		jest.clearAllMocks();
		jest.spyOn(
			require('../../utils/billing/billingAccounts'),
			'getBillingAccountByWorkspaceId',
		).mockResolvedValue(billingAccount);
	});

	it('recomputes zero-usage snapshots as ok', async () => {
		const findOneAndUpdate = jest.fn(async () => ({
			_id: new ObjectId(),
			workspaceId,
			billingAccountId,
			periodStart,
			periodEnd,
			usage: { activeSeats: 0, exports: 0, uploadBytes: 0, uploadGb: 0 },
			usageLimits: billingAccount.usageLimits,
			limitStatus: {
				seats: { used: 0, limit: 5, delta: 0, overLimit: false },
				exports: { used: 0, limit: 100, delta: 0, overLimit: false },
				uploadGb: { used: 0, limit: 10, delta: 0, overLimit: false },
			},
			reconciliationStatus: 'ok',
			createdAt: new Date(),
			updatedAt: new Date(),
		}));

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => []),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'billingAddOnEvents') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne: jest.fn(async () => null),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				if (name === 'usageSnapshots') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOneAndUpdate,
					};
				}
				return {
					findOne: jest.fn(async () => null),
					createIndex: jest.fn(async () => undefined),
				};
			}),
		});

		const snapshot = await recomputeUsageSnapshot({
			workspaceId,
			billingAccount,
		});

		expect(snapshot.reconciliationStatus).toBe('ok');
		expect(findOneAndUpdate).toHaveBeenCalled();
	});

	it('replaces stale pending snapshots on read', async () => {
		const pendingSnapshot = {
			_id: new ObjectId(),
			workspaceId,
			billingAccountId,
			periodStart,
			periodEnd,
			reconciliationStatus: 'pending',
		};

		const findOne = jest.fn(async () => pendingSnapshot);
		const findOneAndUpdate = jest.fn(async () => ({
			...pendingSnapshot,
			reconciliationStatus: 'ok',
			usage: { activeSeats: 0, exports: 0, uploadBytes: 0, uploadGb: 0 },
			usageLimits: billingAccount.usageLimits,
			limitStatus: {
				seats: { used: 0, limit: 5, delta: 0, overLimit: false },
				exports: { used: 0, limit: 100, delta: 0, overLimit: false },
				uploadGb: { used: 0, limit: 10, delta: 0, overLimit: false },
			},
			updatedAt: new Date(),
		}));

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => []),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'billingAddOnEvents') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne: jest.fn(async () => null),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 0),
					};
				}
				if (name === 'usageSnapshots') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne,
						findOneAndUpdate,
					};
				}
				return {
					findOne: jest.fn(async () => null),
					createIndex: jest.fn(async () => undefined),
				};
			}),
		});

		const snapshot = await getCurrentUsageSnapshot({
			workspaceId,
			billingAccount,
		});

		expect(snapshot?.reconciliationStatus).toBe('ok');
		expect(findOneAndUpdate).toHaveBeenCalled();
	});

	it('recomputes old-shape snapshots that lack active seats and limit status', async () => {
		const oldShapeSnapshot = {
			_id: new ObjectId(),
			workspaceId,
			billingAccountId,
			periodStart,
			periodEnd,
			reconciliationStatus: 'ok',
			usage: { seatMonths: 3, exports: 0, uploadBytes: 0, uploadGb: 0 },
			included: { seatMonths: 5, exports: 100, uploadGb: 10, sso: false },
			overages: { seatMonths: 0, exports: 0, uploadGb: 0 },
		};

		const findOne = jest.fn(async () => oldShapeSnapshot);
		const findOneAndUpdate = jest.fn(async () => ({
			...oldShapeSnapshot,
			usage: { activeSeats: 1, exports: 0, uploadBytes: 0, uploadGb: 0 },
			usageLimits: billingAccount.usageLimits,
			limitStatus: {
				seats: { used: 1, limit: 5, delta: 0, overLimit: false },
				exports: { used: 0, limit: 100, delta: 0, overLimit: false },
				uploadGb: { used: 0, limit: 10, delta: 0, overLimit: false },
			},
			updatedAt: new Date(),
		}));

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => []),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 1),
					};
				}
				if (name === 'usageSnapshots') {
					return {
						createIndex: jest.fn(async () => undefined),
						findOne,
						findOneAndUpdate,
					};
				}
				return {
					findOne: jest.fn(async () => null),
					createIndex: jest.fn(async () => undefined),
				};
			}),
		});

		const snapshot = await getCurrentUsageSnapshot({
			workspaceId,
			billingAccount,
		});

		expect(snapshot?.usage.activeSeats).toBe(1);
		expect(findOneAndUpdate).toHaveBeenCalled();
	});

	it('builds summaries from active seats and ignores legacy seat-month events', async () => {
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => {
				if (name === 'usageEvents') {
					return {
						find: jest.fn(() => ({
							toArray: jest.fn(async () => [
								{ metric: 'activated_seat_month', quantity: 99 },
								{ metric: 'completed_export', quantity: 2 },
							]),
						})),
						createIndex: jest.fn(async () => undefined),
					};
				}
				if (name === 'users') {
					return {
						countDocuments: jest.fn(async () => 3),
					};
				}
				return {
					findOne: jest.fn(async () => null),
					createIndex: jest.fn(async () => undefined),
				};
			}),
		});

		const summary = await buildBillingSummary({
			workspaceId,
			account: billingAccount,
		});

		expect(summary.usage.activeSeats).toBe(3);
		expect(summary.usage.exports).toBe(2);
		expect(summary.limitStatus.seats.used).toBe(3);
	});
});
