import { ObjectId } from 'mongodb';
import type { Workspace } from '../../models/workspace';
import { getDb } from '../db';
import { getBillingAccountByWorkspaceId, normalizeUsageLimits } from './billingAccounts';
import { bytesToGb, gbToBytes, resolveBillingPeriod } from './billingPeriod';
import { countActiveExportJobs } from '../exportJobs';
import { aggregateUsageForPeriod, countActiveWorkspaceSeats } from './usageRecording';

type EnforceableUsageMetric = 'completed_export' | 'upload_bytes';

export type MetricLimitCheck = {
	allowed: boolean;
	meteringEnabled: boolean;
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
			meteringEnabled: false,
			enforcementMode: 'overage',
			overage: false,
			used: 0,
			limit: 0,
			metric,
		};
	}

	const { periodStart, periodEnd } = resolveBillingPeriod(account);
	const usage = await aggregateUsageForPeriod({ workspaceId, periodStart, periodEnd });
	const enforcementMode = account.workspacePreferences.enforcementMode;
	const usageLimits = normalizeUsageLimits(account);

	let used = 0;
	let limit = 0;

	if (metric === 'completed_export') {
		const pendingExports = await countActiveExportJobs({ workspaceId, periodStart, periodEnd });
		used = usage.exports + pendingExports;
		limit = usageLimits.exports;
	} else {
		used = usage.uploadBytes;
		limit = gbToBytes(usageLimits.uploadGb);
	}

	const projected = used + additionalQuantity;
	const overage = projected > limit;

	if (!account.meteringEnabled) {
		return {
			allowed: true,
			meteringEnabled: false,
			enforcementMode,
			overage,
			used,
			limit,
			metric,
		};
	}

	if (enforcementMode === 'overage') {
		return {
			allowed: true,
			meteringEnabled: true,
			enforcementMode,
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
			meteringEnabled: true,
			enforcementMode,
			overage: true,
			used,
			limit,
			metric,
			reason: `${label} limit reached for this billing period`,
		};
	}

	return {
		allowed: true,
		meteringEnabled: true,
		enforcementMode,
		overage: false,
		used,
		limit,
		metric,
	};
};

export const assertSeatActivationAllowed = async (
	workspaceId: ObjectId,
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

	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) return { allowed: true };

	const usageLimits = normalizeUsageLimits(account);
	const activeSeats = await countActiveWorkspaceSeats(workspaceId);
	const projectedActiveSeats = activeSeats + additionalActiveSeats;

	if (!account.meteringEnabled || account.workspacePreferences.enforcementMode === 'overage') {
		return { allowed: true };
	}

	// Every future path that changes a workspace member to active must run this guard first.
	if (projectedActiveSeats > usageLimits.seats) {
		return { allowed: false, reason: 'Seat limit reached for this workspace' };
	}

	return { allowed: true };
};

export const verifySeatLimitAfterActivation = async (
	workspaceId: ObjectId,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) return { allowed: true };
	if (!account.meteringEnabled || account.workspacePreferences.enforcementMode === 'overage') {
		return { allowed: true };
	}

	const usageLimits = normalizeUsageLimits(account);
	const activeSeats = await countActiveWorkspaceSeats(workspaceId);
	if (activeSeats > usageLimits.seats) {
		return { allowed: false, reason: 'Seat limit reached for this workspace' };
	}

	return { allowed: true };
};

export const checkUploadWouldExceedLimit = async (
	workspaceId: ObjectId,
	sizeBytes: number,
): Promise<MetricLimitCheck> => checkMetricLimit(workspaceId, 'upload_bytes', sizeBytes);

export const formatUploadLimit = (bytes: number): string => `${bytesToGb(bytes).toFixed(2)} GB`;
