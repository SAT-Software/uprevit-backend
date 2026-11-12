import { ObjectId } from 'mongodb';
import { USAGE_EVENTS_COLLECTION } from '../../models/billing';
import type { UsageEvent } from '../../models/billing';
import { getDb } from '../db';
import { headUploadObject, isTenantUploadKeyAllowed } from '../s3-storage';
import { getBillingAccountByWorkspaceId } from './billingAccounts';
import { resolveUsagePeriod } from './billingPeriod';
import { checkUploadWouldExceedLimit } from './enforcement';
import { recordUsageEvent } from './usageRecording';
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
	if (!account) return;

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

	if (insertedEvent?._id) {
		await trySyncUsageEventToChargebee({
			event: insertedEvent as UsageEvent & { _id: ObjectId },
			account,
		});
	}
};

const uploadIdempotencyKey = (uploadKey: string): string => `upload:${uploadKey.trim()}`;

const hasRecordedUpload = async (uploadKey: string): Promise<boolean> => {
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
	if (!uploadKey.startsWith('uploads/') || await hasRecordedUpload(uploadKey)) return;

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
	const uploadKey = key.startsWith('uploads/') ? key : taggedImageKey;

	if (uploadKey.startsWith('uploads/')) {
		commits.push({ key: uploadKey });
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

export const sumNewUploadCommitBytes = async (
	workspaceId: ObjectId,
	data: unknown,
): Promise<number> => {
	let totalBytes = 0;
	for (const key of await collectNewWorkspaceUploadKeys(workspaceId, data)) {
		totalBytes += (await readUploadSizeBytes(key)) ?? 0;
	}
	return totalBytes;
};

export const assertNewUploadCommitsAllowed = async (
	workspaceId: ObjectId,
	data: unknown,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const newBytes = await sumNewUploadCommitBytes(workspaceId, data);
	if (newBytes <= 0) return { allowed: true };

	const limitCheck = await checkUploadWouldExceedLimit(workspaceId, newBytes);
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
