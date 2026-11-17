import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

jest.mock('../../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../../utils/s3-storage', () => ({
	...(jest.requireActual('../../utils/s3-storage') as object),
	headUploadObject: jest.fn(),
	readUploadObjectPrefix: jest.fn(),
	deleteObjectByKey: jest.fn(),
}));
jest.mock('../../utils/billing/billingAccounts', () => ({
	...(jest.requireActual('../../utils/billing/billingAccounts') as object),
	getBillingAccountByWorkspaceId: jest.fn(),
}));
jest.mock('../../utils/billing/uploadGrants', () => ({
	clearUploadGrant: jest.fn(async () => undefined),
	markUploadGrantMetered: jest.fn(async () => undefined),
	sumPendingUploadGrantBytes: jest.fn(async () => 0),
	getUploadGrants: jest.fn(),
}));

const s3Storage = jest.requireMock('../../utils/s3-storage') as any;
const { getBillingAccountByWorkspaceId } = jest.requireMock('../../utils/billing/billingAccounts') as any;
const usageRecording = require('../../utils/billing/usageRecording');
let recordUsageEvent: jest.SpiedFunction<any>;
const uploadGrants = jest.requireMock('../../utils/billing/uploadGrants') as any;
const { checkUploadWouldExceedLimit } = require('../../utils/billing/enforcement');
const { reconcileExpiredUploadGrants } = require('../../utils/billing/uploadCommit');

const workspaceId = new ObjectId();
const MB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('upload grants', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		recordUsageEvent = jest.spyOn(usageRecording, 'recordUsageEvent').mockResolvedValue(null);
		jest.spyOn(usageRecording, 'aggregateUsageForPeriod').mockResolvedValue({ exports: 0, uploadBytes: 0 } as never);
		getBillingAccountByWorkspaceId.mockResolvedValue({
			_id: new ObjectId(),
			workspaceId,
			status: 'active',
			limits: { enabled: true, enforcementMode: 'block', seats: 5, approverSeats: 0, exports: 10, uploadGb: 1, ssoAllowed: false },
			periodStart: new Date(Date.now() - 86400000),
			periodEnd: new Date(Date.now() + 86400000),
		});
	});

	it('reserves unreferenced granted bytes against the block-mode quota', async () => {
		uploadGrants.sumPendingUploadGrantBytes.mockResolvedValue(1000 * MB);

		const check = await checkUploadWouldExceedLimit(workspaceId, 100 * MB);

		expect(check.allowed).toBe(false);
		expect(check.used).toBe(1000 * MB);
	});

	it('does not count the grant of the upload being committed', async () => {
		await checkUploadWouldExceedLimit(workspaceId, 100 * MB, ['uploads/k']);

		expect(uploadGrants.sumPendingUploadGrantBytes).toHaveBeenCalledWith(workspaceId, ['uploads/k']);
	});

	const mockExpiredGrants = (grants: Array<Record<string, unknown>>) => {
		const collection = {
			find: jest.fn(() => ({ limit: () => ({ toArray: async () => grants }) })),
			deleteOne: jest.fn(),
		};
		uploadGrants.getUploadGrants.mockResolvedValue(collection);
		return collection;
	};

	it('meters an expired grant once with the stored size', async () => {
		const key = `uploads/${workspaceId}/workspace/a.png`;
		const grants = mockExpiredGrants([{ _id: new ObjectId(), key, workspaceId, sizeBytes: 10, contentType: 'image/png' }]);
		const lastModified = new Date(Date.now() - 2 * 3600000);
		s3Storage.headUploadObject.mockResolvedValue({ contentType: 'image/png', sizeBytes: 4096, lastModified });
		s3Storage.readUploadObjectPrefix.mockResolvedValue(PNG);

		await expect(reconcileExpiredUploadGrants()).resolves.toEqual({ processed: 1, metered: 1, removed: 0 });
		expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
			quantity: 4096,
			idempotencyKey: `upload:${key}`,
			occurredAt: lastModified,
		}));
		expect(grants.deleteOne).toHaveBeenCalled();
	});

	it('deletes an image whose bytes do not match its declared type', async () => {
		mockExpiredGrants([{ _id: new ObjectId(), key: 'uploads/x/a.png', workspaceId, sizeBytes: 10, contentType: 'image/png' }]);
		s3Storage.headUploadObject.mockResolvedValue({ contentType: 'image/png', sizeBytes: 10 });
		s3Storage.readUploadObjectPrefix.mockResolvedValue(new TextEncoder().encode('<html><script>'));

		await expect(reconcileExpiredUploadGrants()).resolves.toEqual({ processed: 1, metered: 0, removed: 1 });
		expect(s3Storage.deleteObjectByKey).toHaveBeenCalledWith('uploads/x/a.png');
		expect(recordUsageEvent).not.toHaveBeenCalled();
	});

	it('drops grants whose upload never happened', async () => {
		const grants = mockExpiredGrants([{ _id: new ObjectId(), key: 'uploads/x/a.pdf', workspaceId, sizeBytes: 10, contentType: 'application/pdf' }]);
		s3Storage.headUploadObject.mockResolvedValue(null);

		await expect(reconcileExpiredUploadGrants()).resolves.toEqual({ processed: 1, metered: 0, removed: 0 });
		expect(grants.deleteOne).toHaveBeenCalled();
		expect(recordUsageEvent).not.toHaveBeenCalled();
	});

	it('still checks image bytes after the upload was already metered', async () => {
		mockExpiredGrants([{ _id: new ObjectId(), key: 'uploads/x/b.png', workspaceId, sizeBytes: 10, contentType: 'image/png', metered: true }]);
		s3Storage.headUploadObject.mockResolvedValue({ contentType: 'image/png', sizeBytes: 10 });
		s3Storage.readUploadObjectPrefix.mockResolvedValue(new TextEncoder().encode('not an image'));

		await expect(reconcileExpiredUploadGrants()).resolves.toEqual({ processed: 1, metered: 0, removed: 1 });
		expect(s3Storage.deleteObjectByKey).toHaveBeenCalledWith('uploads/x/b.png');
	});

	it('meters uploads from a closed period in the current one', async () => {
		mockExpiredGrants([{ _id: new ObjectId(), key: 'uploads/x/c.pdf', workspaceId, sizeBytes: 10, contentType: 'application/pdf' }]);
		const lastModified = new Date(Date.now() - 3 * 86400000);
		s3Storage.headUploadObject.mockResolvedValue({ contentType: 'application/pdf', sizeBytes: 10, lastModified });

		await reconcileExpiredUploadGrants();

		const [event] = recordUsageEvent.mock.calls[0] as [{ occurredAt: Date }];
		expect(event.occurredAt.getTime()).toBeGreaterThan(lastModified.getTime());
	});
});
