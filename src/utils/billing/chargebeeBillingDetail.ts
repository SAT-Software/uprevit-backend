import { ObjectId } from 'mongodb';
import type { BillingAccount } from '../../models/billing';
import { isChargebeeConfigured } from '../../config/chargebeeConfig';
import {
	listChargebeeInvoicesForCustomer,
	retrieveChargebeeSubscription,
	type ChargebeeInvoice,
	type ChargebeeSubscription,
} from './chargebeeClient';
import { buildChargebeeMirrorUpdate } from './chargebeeWebhooks';
import { serializeInvoiceSummary } from './invoiceSerializers';
import { limitsToUsageLimits, normalizeLimits } from './billingAccounts';
import { serializeBillingAccount, serializeWorkspaceBillingPreview } from './serializers';

export const resolveInvoicePastDueFromInvoices = (invoices: ChargebeeInvoice[]): boolean =>
	invoices.some((invoice) => {
		if (invoice.status === 'voided') return false;
		return (invoice.amount_due ?? 0) > 0;
	});

export const resolveInvoicePastDue = (
	subscription: ChargebeeSubscription,
	invoices?: ChargebeeInvoice[],
): boolean => {
	if (invoices !== undefined) {
		return resolveInvoicePastDueFromInvoices(invoices);
	}

	return (subscription.due_invoices_count ?? 0) > 0;
};

export const applyLiveChargebeeToSerializedAccount = (
	account: BillingAccount & { _id: ObjectId },
	subscription: ChargebeeSubscription,
	options: { invoicePastDue?: boolean } = {},
) => {
	const invoicePastDue = options.invoicePastDue ?? resolveInvoicePastDue(subscription);
	const mirror = buildChargebeeMirrorUpdate(account, subscription, { invoicePastDue });
	const serialized = serializeBillingAccount(account);
	const mirroredLimits = mirror.limits
		? { ...normalizeLimits(account), ...mirror.limits }
		: null;
	const mirrorChargebee = mirror.chargebee;

	if (!mirrorChargebee || !serialized.chargebee) {
		return {
			...serialized,
			status: mirror.status ?? serialized.status,
			pastDue: mirror.pastDue ?? serialized.pastDue,
			billingCadence: mirror.billingCadence ?? serialized.billingCadence,
			...(mirroredLimits
				? {
					limits: mirroredLimits,
					usageLimits: limitsToUsageLimits(mirroredLimits),
				}
				: {}),
		};
	}

	return {
		...serialized,
		status: mirror.status ?? serialized.status,
		pastDue: mirror.pastDue ?? serialized.pastDue,
		billingCadence: mirror.billingCadence ?? serialized.billingCadence,
		...(mirroredLimits
			? {
				limits: mirroredLimits,
				usageLimits: limitsToUsageLimits(mirroredLimits),
			}
			: {}),
		chargebee: {
			...serialized.chargebee,
			subscriptionStatus: mirrorChargebee.subscriptionStatus ?? serialized.chargebee.subscriptionStatus,
			planId: mirrorChargebee.planId ?? serialized.chargebee.planId,
			billingCadence: mirrorChargebee.billingCadence ?? serialized.chargebee.billingCadence,
			currentTermStart: mirrorChargebee.currentTermStart?.toISOString()
				?? serialized.chargebee.currentTermStart,
			currentTermEnd: mirrorChargebee.currentTermEnd?.toISOString()
				?? serialized.chargebee.currentTermEnd,
			nextBillingAt: mirrorChargebee.nextBillingAt?.toISOString()
				?? serialized.chargebee.nextBillingAt,
		},
		sso: serialized.sso,
	};
};

export const resolveLiveWorkspaceBillingPreview = async (account: BillingAccount | null) => {
	if (!account) return serializeWorkspaceBillingPreview(null);

	const subscriptionId = account.chargebee?.subscriptionId?.trim();
	if (!subscriptionId || !isChargebeeConfigured()) {
		return serializeWorkspaceBillingPreview(account);
	}

	try {
		const customerId = account.chargebee?.customerId?.trim();
		const [subscription, invoices] = await Promise.all([
			retrieveChargebeeSubscription(subscriptionId),
			customerId
				? listChargebeeInvoicesForCustomer(customerId).catch(() => [] as ChargebeeInvoice[])
				: Promise.resolve([] as ChargebeeInvoice[]),
		]);
		const invoicePastDue = resolveInvoicePastDue(subscription, invoices);
		const mirror = buildChargebeeMirrorUpdate(account, subscription, { invoicePastDue });
		const base = serializeWorkspaceBillingPreview(account);
		if (base.status === 'not_set') return base;

		return {
			...base,
			status: mirror.status ?? base.status,
			pastDue: mirror.pastDue ?? base.pastDue,
		};
	} catch {
		return serializeWorkspaceBillingPreview(account);
	}
};

export const buildChargebeeBillingDetail = async (account: BillingAccount & { _id: ObjectId }) => {
	const customerId = account.chargebee?.customerId?.trim();
	const subscriptionId = account.chargebee?.subscriptionId?.trim();

	let serializedAccount = serializeBillingAccount(account);
	let invoices: ReturnType<typeof serializeInvoiceSummary>[] = [];
	let invoiceError: string | null = null;

	if (customerId && isChargebeeConfigured()) {
		let fetchedInvoices: ChargebeeInvoice[] = [];
		let subscription: ChargebeeSubscription | null = null;

		const invoicePromise = listChargebeeInvoicesForCustomer(customerId)
			.then((fetched) => {
				fetchedInvoices = fetched;
				invoices = fetched.map(serializeInvoiceSummary);
			})
			.catch((error) => {
				invoiceError = error instanceof Error ? error.message : 'Failed to fetch invoices';
			});

		const subscriptionPromise = subscriptionId
			? retrieveChargebeeSubscription(subscriptionId)
				.then((resolved) => {
					subscription = resolved;
				})
				.catch(() => undefined)
			: Promise.resolve();

		await Promise.all([invoicePromise, subscriptionPromise]);

		if (subscription) {
			const invoicePastDue = resolveInvoicePastDue(
				subscription,
				fetchedInvoices.length > 0 ? fetchedInvoices : undefined,
			);
			serializedAccount = applyLiveChargebeeToSerializedAccount(account, subscription, { invoicePastDue });
		}
	}

	return {
		account: serializedAccount,
		connection: {
			configured: isChargebeeConfigured(),
			linked: Boolean(subscriptionId),
			customerId: customerId ?? null,
			subscriptionId: subscriptionId ?? null,
		},
		invoices,
		invoiceError,
	};
};
