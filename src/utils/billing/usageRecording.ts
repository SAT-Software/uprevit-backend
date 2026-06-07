import { ObjectId } from 'mongodb';
import {
	BILLING_ADDON_EVENTS_COLLECTION,
	BILLING_ACCOUNTS_COLLECTION,
	USAGE_EVENTS_COLLECTION,
	type BillingAccount,
	type BillingAddOnEvent,
	type BillingUsageMetric,
	type UsageEvent,
	type UsageEventSource,
	type UsageUnit,
} from '../../models/billing';
import { getDb } from '../db';
import { resolveBillingPeriod } from './billingPeriod';
import { getBillingAccountByWorkspaceId } from './billingAccounts';
import { recordCommittedUploadBytes } from './uploadCommit';

let hasEnsuredUsageIndexes = false;

export const ensureUsageEventIndexes = async (): Promise<void> => {
	if (hasEnsuredUsageIndexes) return;

	const db = await getDb();
	const collection = db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION);

	await Promise.all([
		collection.createIndex({ idempotencyKey: 1 }, { unique: true }),
		collection.createIndex({ workspaceId: 1, occurredAt: -1 }),
		collection.createIndex({ workspaceId: 1, billingPeriodStart: 1, billingPeriodEnd: 1 }),
		collection.createIndex({ workspaceId: 1, metric: 1, billingPeriodStart: 1 }),
		db.collection<BillingAddOnEvent>(BILLING_ADDON_EVENTS_COLLECTION).createIndex({ idempotencyKey: 1 }, { unique: true }),
	]);

	hasEnsuredUsageIndexes = true;
};

export type PeriodUsageTotals = {
	activeSeats: number;
	exports: number;
	uploadBytes: number;
};

export const recordUsageEvent = async ({
	workspaceId,
	billingAccountId,
	metric,
	quantity,
	unit,
	source,
	sourceId,
	idempotencyKey,
	occurredAt,
	billingPeriodStart,
	billingPeriodEnd,
	metadata,
}: {
	workspaceId: ObjectId;
	billingAccountId?: ObjectId;
	metric: BillingUsageMetric;
	quantity: number;
	unit: UsageUnit;
	source: UsageEventSource;
	sourceId: string;
	idempotencyKey: string;
	occurredAt?: Date;
	billingPeriodStart: Date;
	billingPeriodEnd: Date;
	metadata?: Record<string, unknown>;
}): Promise<UsageEvent | null> => {
	if (!Number.isFinite(quantity) || quantity === 0) return null;
	if (source !== 'platform_adjustment' && quantity < 0) return null;

	await ensureUsageEventIndexes();
	const db = await getDb();
	const now = occurredAt ?? new Date();

	const event: UsageEvent = {
		workspaceId,
		billingAccountId,
		metric,
		quantity,
		unit,
		source,
		sourceId,
		idempotencyKey,
		occurredAt: now,
		billingPeriodStart,
		billingPeriodEnd,
		metadata,
		createdAt: now,
		updatedAt: now,
	};

	try {
		const result = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).insertOne(event);
		return { ...event, _id: result.insertedId };
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
			return null;
		}
		throw error;
	}
};

export type UploadReconciliationBreakdown = {
	commitBytes: number;
	adjustmentBytes: number;
	totalBytes: number;
};

export const aggregateUploadReconciliationBreakdown = async ({
	workspaceId,
	periodStart,
	periodEnd,
}: {
	workspaceId: ObjectId;
	periodStart: Date;
	periodEnd: Date;
}): Promise<UploadReconciliationBreakdown> => {
	await ensureUsageEventIndexes();
	const db = await getDb();

	const events = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).find({
		workspaceId,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
		metric: 'upload_bytes',
	}).toArray();

	return events.reduce<UploadReconciliationBreakdown>(
		(totals, event) => {
			totals.totalBytes += event.quantity;

			if (event.source === 'platform_adjustment') {
				totals.adjustmentBytes += event.quantity;
			} else if (event.source === 'upload_commit' || event.source === 'reconciliation_backfill') {
				totals.commitBytes += event.quantity;
			}

			return totals;
		},
		{ commitBytes: 0, adjustmentBytes: 0, totalBytes: 0 },
	);
};

export const aggregateUsageForPeriod = async ({
	workspaceId,
	periodStart,
	periodEnd,
}: {
	workspaceId: ObjectId;
	periodStart: Date;
	periodEnd: Date;
}): Promise<PeriodUsageTotals> => {
	await ensureUsageEventIndexes();
	const db = await getDb();

	const events = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).find({
		workspaceId,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
	}).toArray();

	const eventTotals = events.reduce<Omit<PeriodUsageTotals, 'activeSeats'>>(
		(totals, event) => {
			if (event.metric === 'completed_export') {
				totals.exports += event.quantity;
			} else if (event.metric === 'upload_bytes') {
				totals.uploadBytes += event.quantity;
			}
			return totals;
		},
		{ exports: 0, uploadBytes: 0 },
	);

	const activeSeats = await countActiveWorkspaceSeats(workspaceId);

	return {
		activeSeats,
		...eventTotals,
	};
};

export const countActiveWorkspaceSeats = async (workspaceId: ObjectId): Promise<number> => {
	const db = await getDb();
	return db.collection('users').countDocuments({ workspaceId, status: 'active' });
};

export const recordCompletedExport = async ({
	workspaceId,
	jobId,
	occurredAt,
}: {
	workspaceId: ObjectId;
	jobId: ObjectId;
	occurredAt?: Date;
}): Promise<void> => {
	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) return;

	const now = occurredAt ?? new Date();
	const { periodStart, periodEnd } = resolveBillingPeriod(account, now);

	await recordUsageEvent({
		workspaceId,
		billingAccountId: account._id,
		metric: 'completed_export',
		quantity: 1,
		unit: 'count',
		source: 'export_job',
		sourceId: jobId.toString(),
		idempotencyKey: `export:${jobId.toString()}`,
		occurredAt: now,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
	});
};

export { recordCommittedUploadBytes, recordCommittedUploadIfNew, recordUploadCommitsFromPayload } from './uploadCommit';

/** @deprecated Prefer recordCommittedUploadBytes with the S3 upload key. */
export const recordUploadBytes = async ({
	workspaceId,
	sourceFileId,
	uploadKey,
	sizeBytes,
	occurredAt,
}: {
	workspaceId: ObjectId;
	sourceFileId?: ObjectId;
	uploadKey?: string;
	sizeBytes: number;
	occurredAt?: Date;
}): Promise<void> => {
	const resolvedKey = uploadKey?.trim()
		|| (sourceFileId ? `legacy:source-file:${sourceFileId.toString()}` : '');
	if (!resolvedKey) return;

	await recordCommittedUploadBytes({
		workspaceId,
		uploadKey: resolvedKey,
		sizeBytes,
		occurredAt,
		metadata: sourceFileId ? { sourceFileId: sourceFileId.toString() } : undefined,
	});
};

export const recordSsoAddOnEvent = async ({
	workspaceId,
	billingAccountId,
	action,
	occurredAt,
}: {
	workspaceId: ObjectId;
	billingAccountId: ObjectId;
	action: 'enabled' | 'disabled';
	occurredAt?: Date;
}): Promise<void> => {
	await ensureUsageEventIndexes();
	const db = await getDb();
	const account = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).findOne({ _id: billingAccountId });
	if (!account) return;

	const now = occurredAt ?? new Date();
	const { periodStart, periodEnd } = resolveBillingPeriod(account, now);

	const event: BillingAddOnEvent = {
		workspaceId,
		billingAccountId,
		addOn: 'sso',
		action,
		occurredAt: now,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
		idempotencyKey: `sso:${workspaceId.toString()}:${action}:${periodStart.toISOString()}`,
		createdAt: now,
	};

	try {
		await db.collection<BillingAddOnEvent>(BILLING_ADDON_EVENTS_COLLECTION).insertOne(event);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
			return;
		}
		throw error;
	}
};
