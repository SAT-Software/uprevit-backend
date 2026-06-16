import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
	type BillingAccountStatus,
	type BillingCadence,
} from '../../models/billing';
import { getDb } from '../db';
import {
	getChargebeeSeatAddonItemPriceId,
	getChargebeeSsoAddonItemPriceId,
} from '../../config/chargebeeConfig';
import {
	retrieveChargebeeSubscription,
	type ChargebeeSubscription,
	type ChargebeeSubscriptionItem,
} from './chargebeeClient';
import { normalizeLimits } from './billingAccounts';

export const CHARGEBEE_WEBHOOK_EVENTS_COLLECTION = 'chargebeeWebhookEvents';

let hasEnsuredWebhookIndexes = false;

export const ensureChargebeeWebhookIndexes = async (): Promise<void> => {
	if (hasEnsuredWebhookIndexes) return;

	const db = await getDb();
	await db.collection(CHARGEBEE_WEBHOOK_EVENTS_COLLECTION).createIndex(
		{ eventId: 1 },
		{ unique: true },
	);

	hasEnsuredWebhookIndexes = true;
};

const isDuplicateKeyError = (error: unknown): boolean =>
	typeof error === 'object'
	&& error !== null
	&& 'code' in error
	&& (error as { code?: number }).code === 11000;

export const claimChargebeeWebhook = async (
	eventId: string,
	eventType: string,
): Promise<'claimed' | 'duplicate'> => {
	await ensureChargebeeWebhookIndexes();
	const db = await getDb();
	try {
		await db.collection(CHARGEBEE_WEBHOOK_EVENTS_COLLECTION).insertOne({
			eventId,
			eventType,
			processedAt: new Date(),
		});
		return 'claimed';
	} catch (error) {
		if (isDuplicateKeyError(error)) return 'duplicate';
		throw error;
	}
};

export const releaseChargebeeWebhookClaim = async (eventId: string): Promise<void> => {
	const db = await getDb();
	await db.collection(CHARGEBEE_WEBHOOK_EVENTS_COLLECTION).deleteOne({ eventId });
};

const unixToDate = (value?: number): Date | undefined => {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return new Date(value * 1000);
};

const mapBillingCadence = (subscription: ChargebeeSubscription): BillingCadence | undefined => {
	if (subscription.billing_period_unit === 'year') return 'yearly';
	if (subscription.billing_period_unit === 'month') return 'monthly';
	return undefined;
};

const mapAccountStatus = (subscriptionStatus: string, invoicePastDue = false): BillingAccountStatus => {
	if (invoicePastDue) return 'past_due';
	if (subscriptionStatus === 'cancelled') return 'cancelled';
	if (subscriptionStatus === 'active' || subscriptionStatus === 'non_renewing') return 'active';
	if (subscriptionStatus === 'in_trial') return 'pilot';
	return 'active';
};

const subscriptionItems = (subscription: ChargebeeSubscription): ChargebeeSubscriptionItem[] =>
	subscription.subscription_items ?? [];

const findAddonQuantity = (
	items: ChargebeeSubscriptionItem[],
	itemPriceId: string,
): number | undefined => {
	if (!itemPriceId) return undefined;
	const match = items.find((item) => item.item_price_id === itemPriceId);
	return typeof match?.quantity === 'number' ? match.quantity : undefined;
};

const hasAddon = (items: ChargebeeSubscriptionItem[], itemPriceId: string): boolean => {
	if (!itemPriceId) return false;
	return items.some((item) => item.item_price_id === itemPriceId);
};

export const buildChargebeeMirrorUpdate = (
	account: BillingAccount,
	subscription: ChargebeeSubscription,
	options: { invoicePastDue?: boolean } = {},
): Partial<BillingAccount> => {
	const invoicePastDue = options.invoicePastDue ?? (subscription.due_invoices_count ?? 0) > 0;
	const limits = normalizeLimits(account);
	const items = subscriptionItems(subscription);
	const seatItemPriceId = getChargebeeSeatAddonItemPriceId();
	const ssoItemPriceId = getChargebeeSsoAddonItemPriceId();
	const planItem = items.find((item) => item.item_type === 'plan') ?? items[0];
	const seatQuantity = findAddonQuantity(items, seatItemPriceId);
	const planItemQuantity = typeof planItem?.quantity === 'number' ? planItem.quantity : undefined;
	const resolvedSeats = seatQuantity ?? planItemQuantity ?? limits.seats;
	const ssoPresent = hasAddon(items, ssoItemPriceId);
	const sso = account.sso ?? { enabled: false };
	const now = new Date();

	return {
		status: mapAccountStatus(subscription.status, invoicePastDue),
		pastDue: invoicePastDue,
		billingCadence: mapBillingCadence(subscription) ?? account.billingCadence,
		limits: {
			...limits,
			seats: resolvedSeats,
			ssoAllowed: ssoPresent,
		},
		sso: ssoPresent
			? {
				enabled: true,
				enabledAt: sso.enabled ? sso.enabledAt ?? now : now,
				disabledAt: undefined,
			}
			: {
				enabled: false,
				enabledAt: sso.enabledAt,
				disabledAt: sso.enabled ? now : sso.disabledAt,
			},
		chargebee: {
			...(account.chargebee ?? {}),
			customerId: subscription.customer_id,
			subscriptionId: subscription.id,
			subscriptionStatus: subscription.status,
			planId: planItem?.item_price_id ?? subscription.plan_id,
			billingCadence: mapBillingCadence(subscription),
			currentTermStart: unixToDate(subscription.current_term_start),
			currentTermEnd: unixToDate(subscription.current_term_end),
			nextBillingAt: unixToDate(subscription.next_billing_at),
			addOns: items
				.filter((item) => item.item_type === 'addon' || item.item_price_id !== planItem?.item_price_id)
				.map((item) => ({
					itemPriceId: item.item_price_id,
					quantity: item.quantity,
				})),
			lastSyncedAt: now,
			lastSyncError: undefined,
		},
		updatedAt: now,
	};
};

export const findBillingAccountByChargebeeCustomerId = async (
	customerId: string,
): Promise<(BillingAccount & { _id: ObjectId }) | null> => {
	const db = await getDb();
	const account = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).findOne({
		'chargebee.customerId': customerId,
	});
	return account?._id ? account as BillingAccount & { _id: ObjectId } : null;
};

export const findBillingAccountByChargebeeSubscriptionId = async (
	subscriptionId: string,
): Promise<(BillingAccount & { _id: ObjectId }) | null> => {
	const db = await getDb();
	const account = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).findOne({
		'chargebee.subscriptionId': subscriptionId,
	});
	return account?._id ? account as BillingAccount & { _id: ObjectId } : null;
};

export const applyChargebeeSubscriptionMirror = async ({
	account,
	subscription,
	invoicePastDue,
}: {
	account: BillingAccount & { _id: ObjectId };
	subscription: ChargebeeSubscription;
	invoicePastDue?: boolean;
}): Promise<BillingAccount & { _id: ObjectId }> => {
	const db = await getDb();
	const update = buildChargebeeMirrorUpdate(account, subscription, { invoicePastDue });

	await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).updateOne(
		{ _id: account._id },
		{ $set: update },
	);

	const updated = await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).findOne({
		_id: account._id,
	});

	return updated as BillingAccount & { _id: ObjectId };
};

export const syncPastDueFromChargebee = async (subscriptionId: string): Promise<boolean> => {
	const account = await findBillingAccountByChargebeeSubscriptionId(subscriptionId);
	if (!account) return false;

	const subscription = await retrieveChargebeeSubscription(subscriptionId);
	const invoicePastDue = (subscription.due_invoices_count ?? 0) > 0;
	await applyChargebeeSubscriptionMirror({ account, subscription, invoicePastDue });
	return true;
};
