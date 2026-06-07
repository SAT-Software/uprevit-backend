import { ObjectId } from 'mongodb';
import { USAGE_EVENTS_COLLECTION } from '../../models/billing';
import type { UsageEvent } from '../../models/billing';
import { getDb } from '../db';
import { getBillingAccountByWorkspaceId } from './billingAccounts';
import { resolveBillingPeriod } from './billingPeriod';
import { checkUploadWouldExceedLimit } from './enforcement';
import { recordUsageEvent } from './usageRecording';

export const normalizeSizeBytes = (value: unknown): number | undefined => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	return Math.floor(value);
};

export const isNewUploadKey = (previousKey: string | undefined, newKey: string): boolean => {
	const normalizedNew = newKey.trim();
	if (!normalizedNew || !normalizedNew.startsWith('uploads/')) return false;
	return normalizedNew !== (previousKey ?? '').trim();
};

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
	const { periodStart, periodEnd } = resolveBillingPeriod(account, now);

	await recordUsageEvent({
		workspaceId,
		billingAccountId: account._id,
		metric: 'upload_bytes',
		quantity: normalizedBytes,
		unit: 'bytes',
		source: 'upload_commit',
		sourceId: normalizedKey,
		idempotencyKey: `upload:${normalizedKey}`,
		occurredAt: now,
		billingPeriodStart: periodStart,
		billingPeriodEnd: periodEnd,
		metadata,
	});
};

export const recordCommittedUploadIfNew = async ({
	workspaceId,
	previousKey,
	newKey,
	sizeBytes,
	metadata,
}: {
	workspaceId: ObjectId;
	previousKey?: string;
	newKey: string;
	sizeBytes: unknown;
	metadata?: Record<string, unknown>;
}): Promise<void> => {
	if (!isNewUploadKey(previousKey, newKey)) return;

	const normalizedBytes = normalizeSizeBytes(sizeBytes);
	if (!normalizedBytes) return;

	await recordCommittedUploadBytes({
		workspaceId,
		uploadKey: newKey.trim(),
		sizeBytes: normalizedBytes,
		metadata,
	});
};

export type UploadCommitInput = {
	key: string;
	sizeBytes: number;
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
	const sizeBytes = normalizeSizeBytes(record.sizeBytes);

	if (uploadKey.startsWith('uploads/') && sizeBytes) {
		commits.push({ key: uploadKey, sizeBytes });
	}

	for (const nested of Object.values(record)) {
		if (nested && typeof nested === 'object') {
			collectUploadCommitsFromValue(nested, commits);
		}
	}

	return commits;
};

const uploadIdempotencyKey = (uploadKey: string): string => `upload:${uploadKey.trim()}`;

export const sumNewUploadCommitBytes = async (
	workspaceId: ObjectId,
	data: unknown,
): Promise<number> => {
	const commits = collectUploadCommitsFromValue(data);
	const seen = new Set<string>();
	let totalBytes = 0;

	const db = await getDb();
	const events = db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION);

	for (const commit of commits) {
		if (seen.has(commit.key)) continue;
		seen.add(commit.key);

		const existing = await events.findOne({ idempotencyKey: uploadIdempotencyKey(commit.key) });
		if (existing) continue;

		totalBytes += commit.sizeBytes;
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
	const commits = collectUploadCommitsFromValue(data);
	const seen = new Set<string>();

	for (const commit of commits) {
		if (seen.has(commit.key)) continue;
		seen.add(commit.key);

		await recordCommittedUploadBytes({
			workspaceId,
			uploadKey: commit.key,
			sizeBytes: commit.sizeBytes,
		});
	}
};
