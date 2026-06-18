import type { BillingAccount, WorkspaceLimits } from '../../models/billing';
import { ObjectId } from 'mongodb';
import { normalizeLimits } from './billingAccounts';
import { resolveLiveUsageLimits } from './chargebeeWebhooks';

export const resolveEffectiveLimits = async (
	account: BillingAccount & { _id: ObjectId },
): Promise<WorkspaceLimits> => {
	const limits = normalizeLimits(account);
	const liveUsageLimits = await resolveLiveUsageLimits(account);
	if (!liveUsageLimits) return limits;

	return {
		...limits,
		seats: liveUsageLimits.seats,
		ssoAllowed: liveUsageLimits.ssoAllowed,
	};
};
