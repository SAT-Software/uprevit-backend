import { ObjectId } from 'mongodb';
import {
	USAGE_SNAPSHOTS_COLLECTION,
	type BillingAccount,
	type LimitStatus,
	type UsageSnapshot,
	type UsageLimits,
} from '../../models/billing';
import { getDb } from '../db';
import { bytesToGb, resolveBillingPeriod } from './billingPeriod';
import { normalizeUsageLimits } from './billingAccounts';
import { buildLimitStatus } from './limitStatus';
import {
	aggregateUploadReconciliationBreakdown,
	aggregateUsageForPeriod,
} from './usageRecording';

let hasEnsuredSnapshotIndexes = false;

const isCurrentSnapshotShape = (
	snapshot: Partial<UsageSnapshot> | null,
): snapshot is UsageSnapshot & { usage: UsageSnapshot['usage']; usageLimits: UsageLimits; limitStatus: LimitStatus } =>
	Boolean(
		snapshot?.usage
		&& typeof snapshot.usage.activeSeats === 'number'
		&& snapshot.usageLimits
		&& typeof snapshot.usageLimits.seats === 'number'
		&& snapshot.limitStatus
		&& typeof snapshot.limitStatus.seats?.used === 'number',
	);

export const ensureUsageSnapshotIndexes = async (): Promise<void> => {
	if (hasEnsuredSnapshotIndexes) return;

	const db = await getDb();
	await db.collection<UsageSnapshot>(USAGE_SNAPSHOTS_COLLECTION).createIndex(
		{ workspaceId: 1, periodStart: 1, periodEnd: 1 },
		{ unique: true },
	);

	hasEnsuredSnapshotIndexes = true;
};

export const recomputeUsageSnapshot = async ({
	workspaceId,
	billingAccount,
}: {
	workspaceId: ObjectId;
	billingAccount: BillingAccount & { _id: ObjectId };
}): Promise<UsageSnapshot & { _id: ObjectId }> => {
	await ensureUsageSnapshotIndexes();
	const db = await getDb();
	const { periodStart, periodEnd } = resolveBillingPeriod(billingAccount);
	const usage = await aggregateUsageForPeriod({ workspaceId, periodStart, periodEnd });
	const uploadGb = bytesToGb(usage.uploadBytes);
	const usageLimits = normalizeUsageLimits(billingAccount);
	const limitStatus = buildLimitStatus({
		activeSeats: usage.activeSeats,
		exports: usage.exports,
		uploadGb,
		usageLimits,
	});

	const reconciliationStatus = await computeReconciliationStatus({
		workspaceId,
		periodStart,
		periodEnd,
		expectedUploadBytes: usage.uploadBytes,
	});

	const now = new Date();
	const snapshot: UsageSnapshot = {
		workspaceId,
		billingAccountId: billingAccount._id,
		periodStart,
		periodEnd,
		usage: {
			activeSeats: usage.activeSeats,
			exports: usage.exports,
			uploadBytes: usage.uploadBytes,
			uploadGb,
		},
		usageLimits,
		limitStatus,
		reconciliationStatus,
		createdAt: now,
		updatedAt: now,
	};

	const { createdAt, ...snapshotUpdates } = snapshot;

	const result = await db.collection<UsageSnapshot>(USAGE_SNAPSHOTS_COLLECTION).findOneAndUpdate(
		{ workspaceId, periodStart, periodEnd },
		{
			$set: snapshotUpdates,
			$setOnInsert: { createdAt },
		},
		{ upsert: true, returnDocument: 'after' },
	);

	if (!result) {
		throw new Error('Failed to persist usage snapshot');
	}

	return result as UsageSnapshot & { _id: ObjectId };
};

export const getCurrentUsageSnapshot = async ({
	workspaceId,
	billingAccount,
	recomputeIfStale = true,
}: {
	workspaceId: ObjectId;
	billingAccount: BillingAccount & { _id: ObjectId };
	recomputeIfStale?: boolean;
}): Promise<(UsageSnapshot & { _id: ObjectId }) | null> => {
	await ensureUsageSnapshotIndexes();
	const db = await getDb();
	const { periodStart, periodEnd } = resolveBillingPeriod(billingAccount);

	const existing = await db.collection<UsageSnapshot>(USAGE_SNAPSHOTS_COLLECTION).findOne({
		workspaceId,
		periodStart,
		periodEnd,
	});

	if (
		recomputeIfStale &&
		(!existing || existing.reconciliationStatus === 'pending' || !isCurrentSnapshotShape(existing))
	) {
		return recomputeUsageSnapshot({ workspaceId, billingAccount });
	}

	if (!existing?._id) return null;
	return existing as UsageSnapshot & { _id: ObjectId };
};

const computeReconciliationStatus = async ({
	workspaceId,
	periodStart,
	periodEnd,
	expectedUploadBytes,
}: {
	workspaceId: ObjectId;
	periodStart: Date;
	periodEnd: Date;
	expectedUploadBytes: number;
}): Promise<'ok' | 'mismatch'> => {
	const breakdown = await aggregateUploadReconciliationBreakdown({
		workspaceId,
		periodStart,
		periodEnd,
	});

	const recordedBytes = breakdown.commitBytes + breakdown.adjustmentBytes;

	if (expectedUploadBytes === 0 && recordedBytes === 0) return 'ok';
	if (breakdown.totalBytes !== expectedUploadBytes) return 'mismatch';
	if (recordedBytes !== expectedUploadBytes) return 'mismatch';
	return 'ok';
};
