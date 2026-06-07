import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
} from '../models/billing';
import { getDb } from '../utils/db';
import { computeBillingPeriodFromAnchor } from '../utils/billing/billingPeriod';

const ANCHOR_TOLERANCE_MS = 60_000;

const isAlreadyAnchored = (account: BillingAccount): boolean => {
	if (!account.periodStart) return false;
	return Math.abs(account.periodStart.getTime() - account.createdAt.getTime()) <= ANCHOR_TOLERANCE_MS;
};

const main = async () => {
	const db = await getDb();
	const collection = db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION);
	const accounts = await collection.find({}).toArray();

	let updated = 0;
	let skipped = 0;

	for (const account of accounts) {
		if (!account._id || !(account.workspaceId instanceof ObjectId)) {
			skipped += 1;
			continue;
		}

		if (isAlreadyAnchored(account)) {
			skipped += 1;
			continue;
		}

		const anchor = account.createdAt;
		const { periodStart, periodEnd } = computeBillingPeriodFromAnchor(
			anchor,
			account.billingCadence,
			new Date(),
		);

		await collection.updateOne(
			{ _id: account._id },
			{
				$set: {
					periodStart: anchor,
					periodEnd,
					updatedAt: new Date(),
				},
			},
		);

		updated += 1;
		console.log(
			`Updated workspace ${account.workspaceId.toString()}: anchor=${anchor.toISOString()}, current period=${periodStart.toISOString()} – ${periodEnd.toISOString()}`,
		);
	}

	console.log(`Billing period anchor fix complete. Updated: ${updated}, skipped: ${skipped}`);
	console.log(
		'Note: usage events recorded under old calendar-month periods are not retagged automatically. Recompute snapshots after verifying usage totals, or adjust manually for test workspaces.',
	);
	process.exit(0);
};

main().catch((error) => {
	console.error('Billing period anchor fix failed', error);
	process.exit(1);
});
