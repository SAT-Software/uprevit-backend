import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
	type DeprecatedIncludedLimits,
	type UsageLimits,
} from '../../models/billing';
import { getDb } from '../db';
import { defaultPeriodForCadence } from './billingPeriod';

let hasEnsuredBillingIndexes = false;

export const DEFAULT_USAGE_LIMITS: UsageLimits = {
	seats: 5,
	exports: 100,
	uploadGb: 10,
	ssoAllowed: false,
};

/** @deprecated Use DEFAULT_USAGE_LIMITS. */
export const DEFAULT_INCLUDED_LIMITS: DeprecatedIncludedLimits = {
	seatMonths: DEFAULT_USAGE_LIMITS.seats,
	exports: DEFAULT_USAGE_LIMITS.exports,
	uploadGb: DEFAULT_USAGE_LIMITS.uploadGb,
	sso: DEFAULT_USAGE_LIMITS.ssoAllowed,
};

export const usageLimitsToIncluded = (usageLimits: UsageLimits): DeprecatedIncludedLimits => ({
	seatMonths: usageLimits.seats,
	exports: usageLimits.exports,
	uploadGb: usageLimits.uploadGb,
	sso: usageLimits.ssoAllowed,
});

export const normalizeUsageLimits = (account?: Pick<BillingAccount, 'usageLimits' | 'included'> | null): UsageLimits => {
	const source = account?.usageLimits;
	const legacy = account?.included;

	return {
		seats: typeof source?.seats === 'number'
			? source.seats
			: typeof legacy?.seatMonths === 'number'
				? legacy.seatMonths
				: DEFAULT_USAGE_LIMITS.seats,
		exports: typeof source?.exports === 'number'
			? source.exports
			: typeof legacy?.exports === 'number'
				? legacy.exports
				: DEFAULT_USAGE_LIMITS.exports,
		uploadGb: typeof source?.uploadGb === 'number'
			? source.uploadGb
			: typeof legacy?.uploadGb === 'number'
				? legacy.uploadGb
				: DEFAULT_USAGE_LIMITS.uploadGb,
		ssoAllowed: typeof source?.ssoAllowed === 'boolean'
			? source.ssoAllowed
			: typeof legacy?.sso === 'boolean'
				? legacy.sso
				: DEFAULT_USAGE_LIMITS.ssoAllowed,
	};
};

export const ensureBillingAccountIndexes = async (): Promise<void> => {
	if (hasEnsuredBillingIndexes) return;

	const db = await getDb();
	const collection = db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION);

	await Promise.all([
		collection.createIndex({ workspaceId: 1 }, { unique: true }),
		collection.createIndex({ status: 1 }),
		collection.createIndex({ meteringEnabled: 1 }),
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
		meteringEnabled: false,
		billingCadence: 'monthly',
		currency: 'USD',
		netTermDays: 30,
		paymentMode: 'offline_wire',
		periodStart,
		periodEnd,
		usageLimits: { ...DEFAULT_USAGE_LIMITS },
		included: { ...DEFAULT_INCLUDED_LIMITS },
		workspacePreferences: { enforcementMode: 'overage' },
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
