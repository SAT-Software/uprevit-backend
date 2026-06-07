import { ObjectId } from 'mongodb';

export type BillingCadence = 'monthly' | 'yearly';
export type BillingAccountStatus = 'draft' | 'pilot' | 'active' | 'past_due' | 'cancelled';
export type BillingPaymentMode = 'offline_wire' | 'provider_bank_transfer' | 'manual_external';
export type EnforcementMode = 'overage' | 'block';

export type BillingUsageMetric =
	| 'activated_seat_month'
	| 'completed_export'
	| 'upload_bytes';

export type UsageEventSource =
	| 'user_activation'
	| 'export_job'
	| 'upload_commit'
	| 'platform_adjustment'
	| 'reconciliation_backfill';

export type UsageUnit = 'count' | 'bytes';

export type UsageLimits = {
	seats: number;
	exports: number;
	uploadGb: number;
	ssoAllowed: boolean;
};

export type DeprecatedIncludedLimits = {
	seatMonths: number;
	exports: number;
	uploadGb: number;
	sso: boolean;
};

export type LimitStatusMetric = {
	used: number;
	limit: number;
	delta: number;
	overLimit: boolean;
};

export type LimitStatus = {
	seats: LimitStatusMetric;
	exports: LimitStatusMetric;
	uploadGb: LimitStatusMetric;
};

export const BILLING_ACCOUNTS_COLLECTION = 'billingAccounts';
export const USAGE_EVENTS_COLLECTION = 'usageEvents';
export const USAGE_SNAPSHOTS_COLLECTION = 'usageSnapshots';
export const USAGE_ADJUSTMENTS_COLLECTION = 'usageAdjustments';
export const BILLING_ADDON_EVENTS_COLLECTION = 'billingAddOnEvents';

export type BillingAccount = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	status: BillingAccountStatus;
	meteringEnabled: boolean;
	billingCadence: BillingCadence;
	currency: string;
	netTermDays: number;
	paymentMode: BillingPaymentMode;
	periodStart?: Date;
	periodEnd?: Date;
	usageLimits?: UsageLimits;
	/** @deprecated Use usageLimits. Kept for existing documents and one-release API compatibility. */
	included?: DeprecatedIncludedLimits;
	workspacePreferences: {
		enforcementMode: EnforcementMode;
	};
	sso: {
		enabled: boolean;
		enabledAt?: Date;
		disabledAt?: Date;
	};
	pastDue: boolean;
	lastReconciledAt?: Date;
	createdAt: Date;
	updatedAt: Date;
};

export type UsageEvent = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	billingAccountId?: ObjectId;
	metric: BillingUsageMetric;
	quantity: number;
	unit: UsageUnit;
	source: UsageEventSource;
	sourceId: string;
	idempotencyKey: string;
	occurredAt: Date;
	billingPeriodStart: Date;
	billingPeriodEnd: Date;
	metadata?: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
};

export type BillingAddOnEvent = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	billingAccountId: ObjectId;
	addOn: 'sso';
	action: 'enabled' | 'disabled';
	occurredAt: Date;
	billingPeriodStart: Date;
	billingPeriodEnd: Date;
	idempotencyKey: string;
	createdAt: Date;
};

export type UsageSnapshot = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	billingAccountId: ObjectId;
	periodStart: Date;
	periodEnd: Date;
	usage: {
		activeSeats: number;
		exports: number;
		uploadBytes: number;
		uploadGb: number;
	};
	usageLimits: UsageLimits;
	limitStatus: LimitStatus;
	reconciliationStatus: 'pending' | 'ok' | 'mismatch';
	approvedForBillingAt?: Date;
	approvedByPlatformAdminId?: ObjectId;
	createdAt: Date;
	updatedAt: Date;
};

export type UsageAdjustment = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	billingAccountId: ObjectId;
	metric: BillingUsageMetric;
	quantityDelta: number;
	unit: UsageUnit;
	billingPeriodStart: Date;
	billingPeriodEnd: Date;
	createdByPlatformAdminId: ObjectId;
	createdAt: Date;
};
