import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	USAGE_EVENTS_COLLECTION,
	type BillingAccount,
	type BillingUsageMetric,
	type UsageEvent,
	type UsageEventChargebeeSyncStatus,
} from '../../models/billing';
import { getDb } from '../db';
import { logError } from '../logger';
import {
	ingestExportUsageEvent,
	ingestUploadUsageEvent,
	isChargebeeConfigured,
} from './chargebeeUsageEvents';

export const CHARGEBEE_USAGE_WINDOW_MS = 12 * 60 * 60 * 1000;
const RETRYABLE_STATUSES: UsageEventChargebeeSyncStatus[] = ['pending', 'failed', 'pending_link'];

export const buildChargebeeDeduplicationId = (idempotencyKey: string): string =>
	`evt:${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;

const isHashedDeduplicationId = (value: string | undefined): boolean =>
	/^evt:[a-f0-9]{32}$/.test(value ?? '');

const isWithinChargebeeWindow = (occurredAt: Date, now = new Date()): boolean =>
	now.getTime() - occurredAt.getTime() < CHARGEBEE_USAGE_WINDOW_MS;

const isChargebeeSyncableMetric = (metric: BillingUsageMetric): boolean =>
	metric === 'completed_export' || metric === 'upload_bytes';

const buildChargebeeQuantity = (event: UsageEvent): number | null => {
	if (event.metric === 'completed_export') {
		return event.source === 'export_job' ? 1 : event.quantity;
	}

	if (event.metric === 'upload_bytes') {
		return event.quantity;
	}

	return null;
};

const sendToChargebee = async ({
	event,
	subscriptionId,
	deduplicationId,
}: {
	event: UsageEvent;
	subscriptionId: string;
	deduplicationId: string;
}): Promise<void> => {
	const quantity = buildChargebeeQuantity(event);
	if (quantity === null) return;

	if (event.metric === 'completed_export') {
		await ingestExportUsageEvent({
			subscriptionId,
			deduplicationId,
			usageTimestamp: event.occurredAt,
			quantity,
		});
		return;
	}

	await ingestUploadUsageEvent({
		subscriptionId,
		deduplicationId,
		usageTimestamp: event.occurredAt,
		uploadBytes: quantity,
	});
};

const updateChargebeeSync = async ({
	eventId,
	chargebeeSync,
}: {
	eventId: ObjectId;
	chargebeeSync: NonNullable<UsageEvent['chargebeeSync']>;
}): Promise<void> => {
	const db = await getDb();
	const now = new Date();
	await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).updateOne(
		{ _id: eventId },
		{
			$set: {
				chargebeeSync,
				updatedAt: now,
			},
		},
	);
};

export const trySyncUsageEventToChargebee = async ({
	event,
	account,
}: {
	event: UsageEvent & { _id: ObjectId };
	account: BillingAccount & { _id: ObjectId };
}): Promise<void> => {
	if (!isChargebeeSyncableMetric(event.metric)) return;

	const storedDeduplicationId = event.chargebeeSync?.deduplicationId;
	const deduplicationId = isHashedDeduplicationId(storedDeduplicationId)
		? storedDeduplicationId as string
		: buildChargebeeDeduplicationId(event.idempotencyKey);
	const subscriptionId = account.chargebee?.subscriptionId?.trim();
	const previousAttempts = event.chargebeeSync?.attempts ?? 0;
	const now = new Date();

	if (!isWithinChargebeeWindow(event.occurredAt, now)) {
		await updateChargebeeSync({
			eventId: event._id,
			chargebeeSync: {
				status: 'manual_correction_required',
				deduplicationId,
				attempts: previousAttempts,
				lastAttemptAt: now,
				lastError: 'Chargebee usage event window expired (12 hours)',
			},
		});
		return;
	}

	if (!subscriptionId) {
		await updateChargebeeSync({
			eventId: event._id,
			chargebeeSync: {
				status: 'pending_link',
				deduplicationId,
				attempts: previousAttempts,
				lastAttemptAt: now,
			},
		});
		return;
	}

	if (!isChargebeeConfigured()) {
		await updateChargebeeSync({
			eventId: event._id,
			chargebeeSync: {
				status: 'failed',
				deduplicationId,
				attempts: previousAttempts + 1,
				lastAttemptAt: now,
				lastError: 'Chargebee is not configured',
			},
		});
		return;
	}

	try {
		await sendToChargebee({ event, subscriptionId, deduplicationId });

		await updateChargebeeSync({
			eventId: event._id,
			chargebeeSync: {
				status: 'synced',
				deduplicationId,
				attempts: previousAttempts + 1,
				lastAttemptAt: now,
				syncedAt: now,
			},
		});
	} catch (error) {
		const lastError = error instanceof Error ? error.message : 'Chargebee sync failed';
		logError('Failed to sync usage event to Chargebee', error, {
			usageEventId: event._id.toString(),
			workspaceId: event.workspaceId.toString(),
		});

		await updateChargebeeSync({
			eventId: event._id,
			chargebeeSync: {
				status: 'failed',
				deduplicationId,
				attempts: previousAttempts + 1,
				lastAttemptAt: now,
				lastError,
			},
		});
	}
};

export const countFailedUsageEventSyncs = async (workspaceId: ObjectId): Promise<number> => {
	const db = await getDb();
	return db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).countDocuments({
		workspaceId,
		'chargebeeSync.status': { $in: ['failed', 'pending', 'pending_link', 'manual_correction_required'] },
	});
};

export const retryUsageEventSyncById = async ({
	workspaceId,
	eventId,
	account,
}: {
	workspaceId: ObjectId;
	eventId: ObjectId;
	account: BillingAccount & { _id: ObjectId };
}): Promise<UsageEvent & { _id: ObjectId }> => {
	const db = await getDb();
	const event = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).findOne({
		_id: eventId,
		workspaceId,
	});

	if (!event?._id) {
		throw new Error('Usage event not found');
	}

	if (!isChargebeeSyncableMetric(event.metric)) {
		throw new Error('Usage event metric is not syncable to Chargebee');
	}

	if (event.chargebeeSync?.status === 'synced') {
		return event as UsageEvent & { _id: ObjectId };
	}

	await trySyncUsageEventToChargebee({
		event: event as UsageEvent & { _id: ObjectId },
		account,
	});

	const updated = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).findOne({ _id: eventId });
	if (!updated?._id) {
		throw new Error('Usage event not found after retry');
	}

	return updated as UsageEvent & { _id: ObjectId };
};

export const retryPendingUsageEventsForWorkspace = async (
	workspaceId: ObjectId,
	account: BillingAccount & { _id: ObjectId },
): Promise<number> => {
	const db = await getDb();
	const cutoff = new Date(Date.now() - CHARGEBEE_USAGE_WINDOW_MS);

	const events = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).find({
		workspaceId,
		metric: { $in: ['completed_export', 'upload_bytes'] },
		occurredAt: { $gte: cutoff },
		$or: [
			{ 'chargebeeSync.status': { $in: RETRYABLE_STATUSES } },
			{ chargebeeSync: { $exists: false } },
		],
	}).toArray();

	let retried = 0;
	for (const event of events) {
		if (!event._id) continue;
		if (event.chargebeeSync?.status === 'synced') continue;
		await trySyncUsageEventToChargebee({
			event: event as UsageEvent & { _id: ObjectId },
			account,
		});
		retried += 1;
	}

	return retried;
};

export const processScheduledUsageEventRetries = async (): Promise<{
	retried: number;
	agedOut: number;
}> => {
	const db = await getDb();
	const now = new Date();
	const windowStart = new Date(now.getTime() - CHARGEBEE_USAGE_WINDOW_MS);
	const retryWindowStart = new Date(now.getTime() - 11 * 60 * 60 * 1000);

	const agedOut = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).updateMany(
		{
			metric: { $in: ['completed_export', 'upload_bytes'] },
			occurredAt: { $lt: windowStart },
			'chargebeeSync.status': { $in: ['pending', 'failed', 'pending_link'] },
		},
		{
			$set: {
				'chargebeeSync.status': 'manual_correction_required',
				'chargebeeSync.lastError': 'Chargebee usage event window expired (12 hours)',
				updatedAt: now,
			},
		},
	);

	const events = await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).find({
		metric: { $in: ['completed_export', 'upload_bytes'] },
		occurredAt: { $gte: retryWindowStart },
		'chargebeeSync.status': { $in: RETRYABLE_STATUSES },
	}).limit(100).toArray();

	let retried = 0;
	for (const event of events) {
		if (!event._id || !event.billingAccountId) continue;

		const account = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).findOne({
			_id: event.billingAccountId,
		});
		if (!account?._id) continue;

		await trySyncUsageEventToChargebee({
			event: event as UsageEvent & { _id: ObjectId },
			account: account as BillingAccount & { _id: ObjectId },
		});
		retried += 1;
	}

	return { retried, agedOut: agedOut.modifiedCount };
};

export { bytesToUploadMb } from './chargebeeUsageEvents';
