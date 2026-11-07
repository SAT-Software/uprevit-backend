import { ObjectId } from 'mongodb';
import type { Workspace } from '../../models/workspace';
import { getDb } from '../db';
import { getBillingAccountByWorkspaceId, normalizeLimits } from './billingAccounts';
import { resolveEffectiveLimits } from './effectiveLimits';
import { bytesToGb, gbToBytes, resolveUsagePeriod } from './billingPeriod';
import { countActiveExportJobs } from '../exportJobs';
import { aggregateUsageForPeriod, countActiveSeatsByClass, type SeatClass } from './usageRecording';

type EnforceableUsageMetric = 'completed_export' | 'upload_bytes';

export type MetricLimitCheck = {
	allowed: boolean;
	limitsEnabled: boolean;
	enforcementMode: 'overage' | 'block';
	overage: boolean;
	used: number;
	limit: number;
	metric: EnforceableUsageMetric;
	reason?: string;
};

export const isWorkspaceAccessFrozen = (workspace: Workspace): boolean =>
	Boolean(workspace.workspaceAccessFreeze?.enabled);

export const isWorkspaceUsageFrozen = (workspace: Workspace): boolean =>
	Boolean(workspace.workspaceUsageFreeze?.enabled);

export const getWorkspaceById = async (workspaceId: ObjectId): Promise<Workspace | null> => {
	const db = await getDb();
	return db.collection<Workspace>('workspaces').findOne({ _id: workspaceId });
};

export const assertWorkspaceAccessAllowed = async (
	workspaceId: ObjectId,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const workspace = await getWorkspaceById(workspaceId);
	if (!workspace) return { allowed: false, reason: 'Workspace not found' };
	if (isWorkspaceAccessFrozen(workspace)) {
		return { allowed: false, reason: 'Workspace access is frozen' };
	}
	return { allowed: true };
};

export const assertUsageActionAllowed = async (
	workspaceId: ObjectId,
	action: 'invite' | 'export' | 'upload',
	additionalQuantity?: number,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const workspace = await getWorkspaceById(workspaceId);
	if (!workspace) return { allowed: false, reason: 'Workspace not found' };
	if (isWorkspaceAccessFrozen(workspace)) {
		return { allowed: false, reason: 'Workspace access is frozen' };
	}
	if (isWorkspaceUsageFrozen(workspace)) {
		return { allowed: false, reason: 'Workspace usage is frozen' };
	}

	if (action === 'export') {
		const exportCheck = await checkMetricLimit(workspaceId, 'completed_export', additionalQuantity ?? 1);
		if (!exportCheck.allowed) return { allowed: false, reason: exportCheck.reason ?? 'Export limit reached' };
	}

	if (action === 'upload') {
		const uploadCheck = await checkMetricLimit(workspaceId, 'upload_bytes', additionalQuantity ?? 0);
		if (!uploadCheck.allowed) return { allowed: false, reason: uploadCheck.reason ?? 'Upload limit reached' };
	}

	return { allowed: true };
};

export const checkMetricLimit = async (
	workspaceId: ObjectId,
	metric: EnforceableUsageMetric,
	additionalQuantity = 0,
): Promise<MetricLimitCheck> => {
	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) {
		return {
			allowed: true,
			limitsEnabled: false,
			enforcementMode: 'overage',
			overage: false,
			used: 0,
			limit: 0,
			metric,
		};
	}

	const limits = normalizeLimits(account);
	const { periodStart, periodEnd } = resolveUsagePeriod(account);
	const usage = await aggregateUsageForPeriod({ workspaceId, periodStart, periodEnd });

	let used = 0;
	let limit = 0;

	if (metric === 'completed_export') {
		const pendingExports = await countActiveExportJobs({ workspaceId, periodStart, periodEnd });
		used = usage.exports + pendingExports;
		limit = limits.exports;
	} else {
		used = usage.uploadBytes;
		limit = gbToBytes(limits.uploadGb);
	}

	const projected = used + additionalQuantity;
	const overage = projected > limit;

	if (!limits.enabled) {
		return {
			allowed: true,
			limitsEnabled: false,
			enforcementMode: limits.enforcementMode,
			overage,
			used,
			limit,
			metric,
		};
	}

	if (limits.enforcementMode === 'overage') {
		return {
			allowed: true,
			limitsEnabled: true,
			enforcementMode: limits.enforcementMode,
			overage,
			used,
			limit,
			metric,
		};
	}

	if (overage) {
		const label = metric === 'completed_export'
			? 'export'
			: 'upload';
		return {
			allowed: false,
			limitsEnabled: true,
			enforcementMode: limits.enforcementMode,
			overage: true,
			used,
			limit,
			metric,
			reason: `${label} limit reached for this billing period`,
		};
	}

	return {
		allowed: true,
		limitsEnabled: true,
		enforcementMode: limits.enforcementMode,
		overage: false,
		used,
		limit,
		metric,
	};
};

const findSeatLimitReason = async (
	workspaceId: ObjectId,
	seatClass: SeatClass,
	additionalActiveSeats: number,
): Promise<string | null> => {
	if (seatClass === 'manager') return null;
	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) return null;
	const limits = await resolveEffectiveLimits(account);
	if (!limits.enabled || limits.enforcementMode === 'overage') return null;

	const activeSeats = await countActiveSeatsByClass(workspaceId);
	if (seatClass === 'approver') {
		return activeSeats.approver + additionalActiveSeats > limits.approverSeats
			? 'Approver seat limit reached for this workspace'
			: null;
	}
	return activeSeats.full + additionalActiveSeats > limits.seats ? 'Seat limit reached for this workspace' : null;
};

export const assertSeatActivationAllowed = async (
	workspaceId: ObjectId,
	seatClass: SeatClass,
	additionalActiveSeats = 1,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const workspace = await getWorkspaceById(workspaceId);
	if (!workspace) return { allowed: false, reason: 'Workspace not found' };
	if (isWorkspaceAccessFrozen(workspace)) {
		return { allowed: false, reason: 'Workspace access is frozen' };
	}
	if (isWorkspaceUsageFrozen(workspace)) {
		return { allowed: false, reason: 'Workspace usage is frozen' };
	}

	const reason = await findSeatLimitReason(workspaceId, seatClass, additionalActiveSeats);
	return reason ? { allowed: false, reason } : { allowed: true };
};

export const verifySeatLimitAfterActivation = async (
	workspaceId: ObjectId,
	seatClass: SeatClass,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const reason = await findSeatLimitReason(workspaceId, seatClass, 0);
	return reason ? { allowed: false, reason } : { allowed: true };
};

export const checkUploadWouldExceedLimit = async (
	workspaceId: ObjectId,
	sizeBytes: number,
): Promise<MetricLimitCheck> => checkMetricLimit(workspaceId, 'upload_bytes', sizeBytes);

export const formatUploadLimit = (bytes: number): string => `${bytesToGb(bytes).toFixed(2)} GB`;
