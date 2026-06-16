import { ObjectId } from 'mongodb';
import type { BillingAccount, UsageEvent } from '../../models/billing';
import type { Workspace } from '../../models/workspace';
import { bytesToGb, resolveUsagePeriod } from './billingPeriod';
import { limitsToUsageLimits, normalizeLimits } from './billingAccounts';
import { buildLimitStatus } from './limitStatus';
import { aggregateUsageForPeriod } from './usageRecording';
import { resolveLiveUsageLimits } from './chargebeeWebhooks';

export const serializeBillingAccount = (account: BillingAccount & { _id: ObjectId }) => {
	const limits = normalizeLimits(account);

	return {
		id: account._id.toString(),
		workspaceId: account.workspaceId.toString(),
		status: account.status,
		limits,
		limitsEnabled: limits.enabled,
		meteringEnabled: limits.enabled,
		billingCadence: account.billingCadence,
		currency: account.currency,
		netTermDays: account.netTermDays,
		paymentMode: account.paymentMode,
		periodStart: account.periodStart?.toISOString() ?? null,
		periodEnd: account.periodEnd?.toISOString() ?? null,
		usageLimits: limitsToUsageLimits(limits),
		chargebee: account.chargebee
			? {
				customerId: account.chargebee.customerId ?? null,
				subscriptionId: account.chargebee.subscriptionId ?? null,
				subscriptionStatus: account.chargebee.subscriptionStatus ?? null,
				planId: account.chargebee.planId ?? null,
				planName: account.chargebee.planName ?? null,
				billingCadence: account.chargebee.billingCadence ?? null,
				currentTermStart: account.chargebee.currentTermStart?.toISOString() ?? null,
				currentTermEnd: account.chargebee.currentTermEnd?.toISOString() ?? null,
				nextBillingAt: account.chargebee.nextBillingAt?.toISOString() ?? null,
			}
			: null,
		sso: {
			enabled: account.sso.enabled,
			enabledAt: account.sso.enabledAt?.toISOString() ?? null,
			disabledAt: account.sso.disabledAt?.toISOString() ?? null,
		},
		pastDue: account.pastDue,
		createdAt: account.createdAt.toISOString(),
		updatedAt: account.updatedAt.toISOString(),
	};
};

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

	const limits = normalizeLimits(account);

	return {
		status: account.status,
		meteringEnabled: limits.enabled,
		limitsEnabled: limits.enabled,
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
	const limits = normalizeLimits(account);
	const { periodStart, periodEnd, source } = resolveUsagePeriod(account);
	const [usage, liveUsageLimits] = await Promise.all([
		aggregateUsageForPeriod({ workspaceId, periodStart, periodEnd }),
		resolveLiveUsageLimits(account),
	]);
	const uploadGb = bytesToGb(usage.uploadBytes);
	const usageLimits = liveUsageLimits ?? limitsToUsageLimits(limits);
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
			source,
		},
		usage: {
			activeSeats: usage.activeSeats,
			exports: usage.exports,
			uploadBytes: usage.uploadBytes,
			uploadGb,
		},
		limits,
		usageLimits,
		limitStatus,
		addOns: {
			ssoEnabled: account.sso.enabled,
		},
		enforcementMode: limits.enforcementMode,
		limitsEnabled: limits.enabled,
		meteringEnabled: limits.enabled,
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
	chargebeeSync: event.chargebeeSync
		? {
			status: event.chargebeeSync.status,
			deduplicationId: event.chargebeeSync.deduplicationId,
			attempts: event.chargebeeSync.attempts,
			lastError: event.chargebeeSync.lastError ?? null,
		}
		: null,
});
