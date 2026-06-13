import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
	type EnforcementMode,
	type UsageLimits,
	type WorkspaceLimits,
} from '../../models/billing';
import { getDb } from '../db';
import { defaultPeriodForCadence } from './billingPeriod';

let hasEnsuredBillingIndexes = false;

export const DEFAULT_LIMITS: WorkspaceLimits = {
	enabled: false,
	enforcementMode: 'overage',
	seats: 1,
	exports: 100,
	uploadGb: 10,
	ssoAllowed: false,
};

type LegacyBillingAccount = {
	limits?: Partial<WorkspaceLimits>;
	usageLimits?: Partial<UsageLimits>;
	included?: {
		seatMonths?: number;
		exports?: number;
		uploadGb?: number;
		sso?: boolean;
	};
	meteringEnabled?: boolean;
	workspacePreferences?: { enforcementMode?: EnforcementMode };
};

export const limitsToUsageLimits = (limits: WorkspaceLimits): UsageLimits => ({
	seats: limits.seats,
	exports: limits.exports,
	uploadGb: limits.uploadGb,
	ssoAllowed: limits.ssoAllowed,
});

export type NormalizableBillingAccount = LegacyBillingAccount & {
	limits?: Partial<WorkspaceLimits> | WorkspaceLimits;
};

export const normalizeLimits = (
	account?: NormalizableBillingAccount | null,
): WorkspaceLimits => {
	if (account?.limits && typeof account.limits.enabled === 'boolean') {
		return { ...DEFAULT_LIMITS, ...account.limits };
	}

	const legacyUsage = account?.usageLimits;
	const legacyIncluded = account?.included;

	return {
		enabled: account?.meteringEnabled ?? DEFAULT_LIMITS.enabled,
		enforcementMode: account?.workspacePreferences?.enforcementMode ?? DEFAULT_LIMITS.enforcementMode,
		seats: typeof legacyUsage?.seats === 'number'
			? legacyUsage.seats
			: typeof legacyIncluded?.seatMonths === 'number'
				? legacyIncluded.seatMonths
				: DEFAULT_LIMITS.seats,
		exports: typeof legacyUsage?.exports === 'number'
			? legacyUsage.exports
			: typeof legacyIncluded?.exports === 'number'
				? legacyIncluded.exports
				: DEFAULT_LIMITS.exports,
		uploadGb: typeof legacyUsage?.uploadGb === 'number'
			? legacyUsage.uploadGb
			: typeof legacyIncluded?.uploadGb === 'number'
				? legacyIncluded.uploadGb
				: DEFAULT_LIMITS.uploadGb,
		ssoAllowed: typeof legacyUsage?.ssoAllowed === 'boolean'
			? legacyUsage.ssoAllowed
			: typeof legacyIncluded?.sso === 'boolean'
				? legacyIncluded.sso
				: DEFAULT_LIMITS.ssoAllowed,
	};
};

/**
 * @deprecated Use normalizeLimits instead.
 * @param {LegacyBillingAccount | null} account
 * @return {UsageLimits}
 */
export const normalizeUsageLimits = (account?: LegacyBillingAccount | null): UsageLimits =>
	limitsToUsageLimits(normalizeLimits(account));

export const ensureBillingAccountIndexes = async (): Promise<void> => {
	if (hasEnsuredBillingIndexes) return;

	const db = await getDb();
	const collection = db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION);

	await Promise.all([
		collection.createIndex({ workspaceId: 1 }, { unique: true }),
		collection.createIndex({ status: 1 }),
		collection.createIndex({ 'limits.enabled': 1 }),
		collection.createIndex({ pastDue: 1 }),
	]);

	hasEnsuredBillingIndexes = true;
};

export const createBillingAccountForWorkspace = async (
	workspaceId: ObjectId,
): Promise<BillingAccount & { _id: ObjectId }> => {
	await ensureBillingAccountIndexes();

	const db = await getDb();
	const collection = db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION);
	const existing = await collection.findOne({ workspaceId });
	if (existing?._id) {
		return existing as BillingAccount & { _id: ObjectId };
	}

	const now = new Date();
	const { periodStart, periodEnd } = defaultPeriodForCadence('monthly', now);

	const account: BillingAccount = {
		workspaceId,
		status: 'draft',
		limits: { ...DEFAULT_LIMITS },
		billingCadence: 'monthly',
		currency: 'USD',
		netTermDays: 30,
		paymentMode: 'offline_wire',
		periodStart,
		periodEnd,
		sso: { enabled: false },
		pastDue: false,
		createdAt: now,
		updatedAt: now,
	};

	const result = await collection.insertOne(account);
	return { ...account, _id: result.insertedId };
};

export const getBillingAccountByWorkspaceId = async (
	workspaceId: ObjectId,
): Promise<(BillingAccount & { _id: ObjectId }) | null> => {
	await ensureBillingAccountIndexes();
	const db = await getDb();
	const account = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).findOne({ workspaceId });
	if (!account?._id) return null;
	return account as BillingAccount & { _id: ObjectId };
};

export const backfillBillingAccounts = async (): Promise<{ created: number; existing: number }> => {
	await ensureBillingAccountIndexes();
	const db = await getDb();
	const workspaces = await db.collection('workspaces').find({}, { projection: { _id: 1 } }).toArray();

	let created = 0;
	let existing = 0;

	for (const workspace of workspaces) {
		if (!(workspace._id instanceof ObjectId)) continue;
		const account = await getBillingAccountByWorkspaceId(workspace._id);
		if (account) {
			existing += 1;
			continue;
		}
		await createBillingAccountForWorkspace(workspace._id);
		created += 1;
	}

	return { created, existing };
};
