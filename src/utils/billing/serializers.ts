import { ObjectId } from 'mongodb';
import type {
	BillingAccount,
	UsageAdjustment,
	UsageEvent,
	UsageSnapshot,
} from '../../models/billing';
import type { Workspace } from '../../models/workspace';
import { bytesToGb, resolveBillingPeriod } from './billingPeriod';
import { normalizeUsageLimits, usageLimitsToIncluded } from './billingAccounts';
import { buildLimitStatus } from './limitStatus';
import { aggregateUsageForPeriod } from './usageRecording';

export const serializeBillingAccount = (account: BillingAccount & { _id: ObjectId }) => ({
	id: account._id.toString(),
	workspaceId: account.workspaceId.toString(),
	status: account.status,
	meteringEnabled: account.meteringEnabled,
	limitsEnabled: account.meteringEnabled,
	billingCadence: account.billingCadence,
	currency: account.currency,
	netTermDays: account.netTermDays,
	paymentMode: account.paymentMode,
	periodStart: account.periodStart?.toISOString() ?? null,
	periodEnd: account.periodEnd?.toISOString() ?? null,
	usageLimits: normalizeUsageLimits(account),
	included: usageLimitsToIncluded(normalizeUsageLimits(account)),
	workspacePreferences: account.workspacePreferences,
	sso: {
		enabled: account.sso.enabled,
		enabledAt: account.sso.enabledAt?.toISOString() ?? null,
		disabledAt: account.sso.disabledAt?.toISOString() ?? null,
	},
	pastDue: account.pastDue,
	lastReconciledAt: account.lastReconciledAt?.toISOString() ?? null,
	createdAt: account.createdAt.toISOString(),
	updatedAt: account.updatedAt.toISOString(),
});

export const serializeWorkspaceBillingPreview = (account: BillingAccount | null) => {
	if (!account) {
		return {
			status: 'not_set' as const,
			meteringEnabled: null,
			limitsEnabled: null,
			billingCadence: null,
			currency: null,
			pastDue: null,
		};
	}

	return {
		status: account.status,
		meteringEnabled: account.meteringEnabled,
		limitsEnabled: account.meteringEnabled,
		billingCadence: account.billingCadence,
		currency: account.currency,
		pastDue: account.pastDue,
	};
};

export const serializeWorkspaceFreezes = (workspace: Workspace) => ({
	usageFreeze: workspace.workspaceUsageFreeze
		? {
			enabled: workspace.workspaceUsageFreeze.enabled,
			updatedAt: workspace.workspaceUsageFreeze.updatedAt.toISOString(),
		}
		: { enabled: false, updatedAt: null },
	accessFreeze: workspace.workspaceAccessFreeze
		? {
			enabled: workspace.workspaceAccessFreeze.enabled,
			updatedAt: workspace.workspaceAccessFreeze.updatedAt.toISOString(),
		}
		: { enabled: false, updatedAt: null },
});

export const buildBillingSummary = async ({
	account,
	workspaceId,
}: {
	account: BillingAccount & { _id: ObjectId };
	workspaceId: ObjectId;
}) => {
	const { periodStart, periodEnd } = resolveBillingPeriod(account);
	const usage = await aggregateUsageForPeriod({ workspaceId, periodStart, periodEnd });
	const uploadGb = bytesToGb(usage.uploadBytes);
	const usageLimits = normalizeUsageLimits(account);
	const limitStatus = buildLimitStatus({
		activeSeats: usage.activeSeats,
		exports: usage.exports,
		uploadGb,
		usageLimits,
	});

	return {
		account: serializeBillingAccount(account),
		period: {
			start: periodStart.toISOString(),
			end: periodEnd.toISOString(),
		},
		usage: {
			activeSeats: usage.activeSeats,
			exports: usage.exports,
			uploadBytes: usage.uploadBytes,
			uploadGb,
		},
		usageLimits,
		included: usageLimitsToIncluded(usageLimits),
		limitStatus,
		addOns: {
			ssoEnabled: account.sso.enabled,
		},
		enforcementMode: account.workspacePreferences.enforcementMode,
		meteringEnabled: account.meteringEnabled,
		limitsEnabled: account.meteringEnabled,
	};
};

export const serializeUsageEvent = (event: UsageEvent & { _id: ObjectId }) => ({
	id: event._id.toString(),
	metric: event.metric,
	quantity: event.quantity,
	unit: event.unit,
	source: event.source,
	sourceId: event.sourceId,
	occurredAt: event.occurredAt.toISOString(),
	billingPeriodStart: event.billingPeriodStart.toISOString(),
	billingPeriodEnd: event.billingPeriodEnd.toISOString(),
});

export const serializeUsageSnapshot = (snapshot: UsageSnapshot & { _id: ObjectId }) => ({
	id: snapshot._id.toString(),
	periodStart: snapshot.periodStart.toISOString(),
	periodEnd: snapshot.periodEnd.toISOString(),
	usage: snapshot.usage,
	usageLimits: snapshot.usageLimits,
	included: usageLimitsToIncluded(snapshot.usageLimits),
	limitStatus: snapshot.limitStatus,
	reconciliationStatus: snapshot.reconciliationStatus,
	approvedForBillingAt: snapshot.approvedForBillingAt?.toISOString() ?? null,
	updatedAt: snapshot.updatedAt.toISOString(),
});

export const serializeUsageAdjustment = (adjustment: UsageAdjustment & { _id: ObjectId }) => ({
	id: adjustment._id.toString(),
	metric: adjustment.metric,
	quantityDelta: adjustment.quantityDelta,
	unit: adjustment.unit,
	billingPeriodStart: adjustment.billingPeriodStart.toISOString(),
	billingPeriodEnd: adjustment.billingPeriodEnd.toISOString(),
	createdAt: adjustment.createdAt.toISOString(),
});
