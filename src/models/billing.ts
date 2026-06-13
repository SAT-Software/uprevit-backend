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
	| 'platform_adjustment';

export type UsageUnit = 'count' | 'bytes';

/** Platform-admin and Chargebee-mirrored limits for a workspace. */
export type WorkspaceLimits = {
	enabled: boolean;
	enforcementMode: EnforcementMode;
	seats: number;
	exports: number;
	uploadGb: number;
	ssoAllowed: boolean;
};

/** @deprecated Use WorkspaceLimits for limit values without enabled/enforcementMode. */
export type UsageLimits = Pick<WorkspaceLimits, 'seats' | 'exports' | 'uploadGb' | 'ssoAllowed'>;

export type BillingAccountChargebee = {
	customerId?: string;
	subscriptionId?: string;
	subscriptionStatus?: string;
	planId?: string;
	planName?: string;
	billingCadence?: BillingCadence;
	currentTermStart?: Date;
	currentTermEnd?: Date;
	nextBillingAt?: Date;
	addOns?: Array<{ itemPriceId: string; name?: string; quantity?: number }>;
	lastSyncedAt?: Date;
	lastSyncError?: string;
};

export type UsageEventChargebeeSyncStatus =
	| 'pending_link'
	| 'pending'
	| 'synced'
	| 'failed'
	| 'manual_correction_required';

export type UsageEventChargebeeSync = {
	status: UsageEventChargebeeSyncStatus;
	deduplicationId: string;
	attempts: number;
	lastAttemptAt?: Date;
	nextAttemptAt?: Date;
	syncedAt?: Date;
	lastError?: string;
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

/** Stored in `billingAccounts`; domain name WorkspaceBillingProfile. */
export type BillingAccount = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	status: BillingAccountStatus;
	limits: WorkspaceLimits;
	chargebee?: BillingAccountChargebee;
	billingCadence: BillingCadence;
	currency: string;
	netTermDays: number;
	paymentMode: BillingPaymentMode;
	/** Internal period anchor when Chargebee term is not linked. */
	periodStart?: Date;
	periodEnd?: Date;
	sso: {
		enabled: boolean;
		enabledAt?: Date;
		disabledAt?: Date;
	};
	pastDue: boolean;
	createdAt: Date;
	updatedAt: Date;
};

export type WorkspaceBillingProfile = BillingAccount;

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
	chargebeeSync?: UsageEventChargebeeSync;
	createdAt: Date;
	updatedAt: Date;
};
