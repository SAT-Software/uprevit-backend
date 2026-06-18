import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
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

export const limitsToUsageLimits = (limits: WorkspaceLimits): UsageLimits => ({
	seats: limits.seats,
	exports: limits.exports,
	uploadGb: limits.uploadGb,
	ssoAllowed: limits.ssoAllowed,
});

export type NormalizableBillingAccount = {
	limits?: Partial<WorkspaceLimits> | WorkspaceLimits;
};

export const normalizeLimits = (
	account?: NormalizableBillingAccount | null,
): WorkspaceLimits => ({ ...DEFAULT_LIMITS, ...account?.limits });

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
