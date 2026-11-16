import { ObjectId } from 'mongodb';
import { USAGE_EVENTS_COLLECTION } from '../../models/billing';
import type { UsageEvent } from '../../models/billing';
import { getDb } from '../db';
import { deleteObjectByKey, headUploadObject, isTenantUploadKeyAllowed, readUploadObjectPrefix } from '../s3-storage';
import { MAGIC_BYTES } from '../supportAttachments';
import { logError } from '../logger';
import { getBillingAccountByWorkspaceId } from './billingAccounts';
import { resolveUsagePeriod } from './billingPeriod';
import { checkUploadWouldExceedLimit } from './enforcement';
import { recordUsageEvent } from './usageRecording';
import { getUploadGrants, markUploadGrantMetered } from './uploadGrants';
import {
	buildChargebeeDeduplicationId,
	trySyncUsageEventToChargebee,
} from './usageEventChargebeeSync';

export const normalizeSizeBytes = (value: unknown): number | undefined => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	return Math.floor(value);
};

export const readUploadSizeBytes = async (key: string): Promise<number | undefined> =>
	normalizeSizeBytes((await headUploadObject(key.trim()))?.sizeBytes);

export const recordCommittedUploadBytes = async ({
	workspaceId,
	uploadKey,
	sizeBytes,
	metadata,
	occurredAt,
}: {
	workspaceId: ObjectId;
	uploadKey: string;
	sizeBytes: number;
	metadata?: Record<string, unknown>;
	occurredAt?: Date;
}): Promise<void> => {
	const normalizedKey = uploadKey.trim();
	const normalizedBytes = normalizeSizeBytes(sizeBytes);
	if (!normalizedKey.startsWith('uploads/') || !normalizedBytes) return;

	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) {
		await markUploadGrantMetered(normalizedKey);
		return;
	}

	const now = occurredAt ?? new Date();
	const { periodStart, periodEnd } = resolveUsagePeriod(account, now);

	const idempotencyKey = `upload:${normalizedKey}`;
	const insertedEvent = await recordUsageEvent({
		workspaceId,
		billingAccountId: account._id,
		metric: 'upload_bytes',
		quantity: normalizedBytes,
		unit: 'bytes',
		source: 'upload_commit',
		sourceId: normalizedKey,
		idempotencyKey,
		occurredAt: now,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
		metadata,
		chargebeeSync: {
			status: 'pending',
			deduplicationId: buildChargebeeDeduplicationId(idempotencyKey),
			attempts: 0,
		},
	});
	await markUploadGrantMetered(normalizedKey);

	if (insertedEvent?._id) {
		await trySyncUsageEventToChargebee({
			event: insertedEvent as UsageEvent & { _id: ObjectId },
			account,
		});
	}
};

const uploadIdempotencyKey = (uploadKey: string): string => `upload:${uploadKey.trim()}`;

export const hasRecordedUpload = async (uploadKey: string): Promise<boolean> => {
	const db = await getDb();
	return Boolean(await db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).findOne(
		{ idempotencyKey: uploadIdempotencyKey(uploadKey) },
		{ projection: { _id: 1 } },
	));
};

export const recordCommittedUploadIfNew = async ({
	workspaceId,
	newKey,
	metadata,
}: {
	workspaceId: ObjectId;
	newKey: string;
	metadata?: Record<string, unknown>;
}): Promise<void> => {
	const uploadKey = newKey.trim();
	const inWorkspace = isTenantUploadKeyAllowed(uploadKey, { workspaceId }) || uploadKey.startsWith('uploads/pending/');
	if (!inWorkspace || await hasRecordedUpload(uploadKey)) return;

	const sizeBytes = await readUploadSizeBytes(uploadKey);
	if (!sizeBytes) return;

	await recordCommittedUploadBytes({ workspaceId, uploadKey, sizeBytes, metadata });
};

export type UploadCommitInput = {
	key: string;
};

export const collectUploadCommitsFromValue = (
	value: unknown,
	commits: UploadCommitInput[] = [],
): UploadCommitInput[] => {
	if (!value || typeof value !== 'object') return commits;

	if (Array.isArray(value)) {
		for (const item of value) {
			collectUploadCommitsFromValue(item, commits);
		}
		return commits;
	}

	const record = value as Record<string, unknown>;
	const key = typeof record.key === 'string' ? record.key.trim() : '';
	const taggedImageKey = typeof record.tagged_image_key === 'string'
		? record.tagged_image_key.trim()
		: '';
	for (const uploadKey of [key, taggedImageKey]) {
		if (uploadKey.startsWith('uploads/')) commits.push({ key: uploadKey });
	}

	for (const nested of Object.values(record)) {
		if (nested && typeof nested === 'object') {
			collectUploadCommitsFromValue(nested, commits);
		}
	}

	return commits;
};

const collectNewWorkspaceUploadKeys = async (workspaceId: ObjectId, data: unknown): Promise<string[]> => {
	const keys = [...new Set(collectUploadCommitsFromValue(data).map((commit) => commit.key))]
		.filter((key) => isTenantUploadKeyAllowed(key, { workspaceId }));
	const recorded = await Promise.all(keys.map(hasRecordedUpload));
	return keys.filter((_, index) => !recorded[index]);
};

const sumUploadBytes = async (keys: string[]): Promise<number> => {
	let totalBytes = 0;
	for (const key of keys) {
		totalBytes += (await readUploadSizeBytes(key)) ?? 0;
	}
	return totalBytes;
};

export const sumNewUploadCommitBytes = async (
	workspaceId: ObjectId,
	data: unknown,
): Promise<number> => sumUploadBytes(await collectNewWorkspaceUploadKeys(workspaceId, data));

export const assertNewUploadCommitsAllowed = async (
	workspaceId: ObjectId,
	data: unknown,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const keys = await collectNewWorkspaceUploadKeys(workspaceId, data);
	const newBytes = await sumUploadBytes(keys);
	if (newBytes <= 0) return { allowed: true };

	const limitCheck = await checkUploadWouldExceedLimit(workspaceId, newBytes, keys);
	if (!limitCheck.allowed) {
		return { allowed: false, reason: limitCheck.reason ?? 'Upload limit reached' };
	}

	return { allowed: true };
};

export const recordUploadCommitsFromPayload = async (
	workspaceId: ObjectId,
	data: unknown,
): Promise<void> => {
	for (const uploadKey of await collectNewWorkspaceUploadKeys(workspaceId, data)) {
		const sizeBytes = await readUploadSizeBytes(uploadKey);
		if (sizeBytes) await recordCommittedUploadBytes({ workspaceId, uploadKey, sizeBytes });
	}
};

const RECONCILE_GRACE_MS = 5 * 60 * 1000;
const RECONCILE_BATCH_SIZE = 200;

const hasDeclaredImageSignature = async (key: string, contentType: string): Promise<boolean> => {
	const matches = MAGIC_BYTES[contentType as keyof typeof MAGIC_BYTES];
	if (!matches) return true;
	const bytes = await readUploadObjectPrefix(key);
	return Boolean(bytes && matches(bytes));
};

/**
 * Checks every upload once its presigned URL has expired: images whose bytes do not match their
 * declared type are deleted, and uploads no record has metered yet are metered from the stored
 * size and upload time, so bytes count toward usage even when nothing references the key.
 * @param {Date} now Current time
 * @return {Promise<{processed: number, metered: number, removed: number}>} Run counts
 */
export const reconcileExpiredUploadGrants = async (now = new Date()) => {
	const grants = await getUploadGrants();
	const expired = await grants
		.find({ expiresAt: { $lt: new Date(now.getTime() - RECONCILE_GRACE_MS) } })
		.limit(RECONCILE_BATCH_SIZE)
		.toArray();
	const counts = { processed: 0, metered: 0, removed: 0 };

	for (const grant of expired) {
		try {
			const head = await headUploadObject(grant.key);
			if (head && !(await hasDeclaredImageSignature(grant.key, grant.contentType))) {
				await deleteObjectByKey(grant.key);
				counts.removed += 1;
			} else if (head?.sizeBytes && !grant.metered) {
				await recordCommittedUploadBytes({
					workspaceId: grant.workspaceId,
					uploadKey: grant.key,
					sizeBytes: head.sizeBytes,
					metadata: { source: 'upload_reconcile' },
					occurredAt: head.lastModified,
				});
				counts.metered += 1;
			}
			await grants.deleteOne({ _id: grant._id });
			counts.processed += 1;
		} catch (error) {
			logError('Failed to reconcile upload grant', error, { key: grant.key });
		}
	}

	return counts;
};
