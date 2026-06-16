import { ObjectId } from 'mongodb';
import {
	USAGE_EVENTS_COLLECTION,
	type BillingUsageMetric,
	type UsageEvent,
	type UsageEventSource,
	type UsageUnit,
} from '../../models/billing';
import { getDb } from '../db';
import { resolveUsagePeriod } from './billingPeriod';
import { getBillingAccountByWorkspaceId } from './billingAccounts';
import {
	buildChargebeeDeduplicationId,
	trySyncUsageEventToChargebee,
} from './usageEventChargebeeSync';
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
	chargebeeSync,
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
	chargebeeSync?: UsageEvent['chargebeeSync'];
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
		chargebeeSync,
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

	// Match events recorded for this period, or events that occurred within it.
	// Chargebee term dates can change after events were written, so occurredAt keeps totals accurate.
	const events = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).find({
		workspaceId,
		$or: [
			{ billingPeriodStart: periodStart, billingPeriodEnd: periodEnd },
			{ occurredAt: { $gte: periodStart, $lte: periodEnd } },
		],
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
	const { periodStart, periodEnd } = resolveUsagePeriod(account, now);
	const idempotencyKey = `export:${jobId.toString()}`;

	const insertedEvent = await recordUsageEvent({
		workspaceId,
		billingAccountId: account._id,
		metric: 'completed_export',
		quantity: 1,
		unit: 'count',
		source: 'export_job',
		sourceId: jobId.toString(),
		idempotencyKey,
		occurredAt: now,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
		chargebeeSync: {
			status: 'pending',
			deduplicationId: buildChargebeeDeduplicationId(idempotencyKey),
			attempts: 0,
		},
	});

	if (insertedEvent?._id) {
		await trySyncUsageEventToChargebee({ event: insertedEvent as UsageEvent & { _id: ObjectId }, account });
	}
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
