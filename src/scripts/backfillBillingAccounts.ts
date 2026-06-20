import { backfillBillingAccounts } from '../utils/billing/billingAccounts';

const main = async () => {
	const result = await backfillBillingAccounts();
	console.log(`Billing backfill complete. Created: ${result.created}, existing: ${result.existing}`);
	process.exit(0);
};

main().catch((error) => {
	console.error('Billing backfill failed', error);
	process.exit(1);
});
