import { ObjectId } from 'mongodb';
import { BILLING_ACCOUNTS_COLLECTION, type BillingAccount } from '../../models/billing';
import { getDb } from '../db';
import { ensureBillingAccountIndexes } from './billingAccounts';
import { recomputeUsageSnapshot } from './snapshots';

export type ReconciliationRunResult = {
	workspaceId: string;
	status: 'ok' | 'mismatch' | 'skipped';
	reconciliationStatus?: 'pending' | 'ok' | 'mismatch';
};

export const runBillingReconciliation = async ({
	workspaceId,
}: {
	workspaceId?: ObjectId;
} = {}): Promise<ReconciliationRunResult[]> => {
	await ensureBillingAccountIndexes();
	const db = await getDb();
	const query = workspaceId ? { workspaceId } : {};
	const accounts = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).find(query).toArray();
	const results: ReconciliationRunResult[] = [];
	const now = new Date();

	for (const account of accounts) {
		if (!account._id || !(account.workspaceId instanceof ObjectId)) {
			results.push({ workspaceId: 'unknown', status: 'skipped' });
			continue;
		}

		const snapshot = await recomputeUsageSnapshot({
			workspaceId: account.workspaceId,
			billingAccount: account as BillingAccount & { _id: ObjectId },
		});

		await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).updateOne(
			{ _id: account._id },
			{ $set: { lastReconciledAt: now, updatedAt: now } },
		);

		results.push({
			workspaceId: account.workspaceId.toString(),
			status: snapshot.reconciliationStatus === 'ok' ? 'ok' : 'mismatch',
			reconciliationStatus: snapshot.reconciliationStatus,
		});
	}

	return results;
};
