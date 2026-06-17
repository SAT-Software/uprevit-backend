import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
	buildChargebeeMirrorUpdate,
	claimChargebeeWebhook,
	isStaleChargebeeSubscriptionEvent,
	resolveChargebeeSubscriptionForMirror,
	resolveSubscriptionSeatQuantity,
	syncPastDueFromChargebee,
} from '../../utils/billing/chargebeeWebhooks';
import type { BillingAccount } from '../../models/billing';
import { ObjectId } from 'mongodb';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/billing/chargebeeClient', () => ({
	retrieveChargebeeSubscription: jest.fn(),
	listChargebeeInvoicesForCustomer: jest.fn(),
}));

import { getDb } from '../../utils/db';
import {
	listChargebeeInvoicesForCustomer,
	retrieveChargebeeSubscription,
} from '../../utils/billing/chargebeeClient';

const mockGetDb = getDb as jest.MockedFunction<typeof getDb>;
const mockRetrieveChargebeeSubscription = retrieveChargebeeSubscription as jest.MockedFunction<
	typeof retrieveChargebeeSubscription
>;
const mockListChargebeeInvoicesForCustomer = listChargebeeInvoicesForCustomer as jest.MockedFunction<
	typeof listChargebeeInvoicesForCustomer
>;

const clearAddonEnv = () => {
	delete process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID;
	delete process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_MONTHLY;
	delete process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_YEARLY;
	delete process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID;
	delete process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID_MONTHLY;
	delete process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID_YEARLY;
};

describe('chargebee webhooks mirror', () => {
	const baseAccount: BillingAccount & { _id: ObjectId } = {
		_id: new ObjectId(),
		workspaceId: new ObjectId(),
		status: 'draft',
		limits: {
			enabled: false,
			enforcementMode: 'overage',
			seats: 5,
			exports: 100,
			uploadGb: 10,
			ssoAllowed: false,
		},
		billingCadence: 'monthly',
		currency: 'USD',
		netTermDays: 30,
		paymentMode: 'offline_wire',
		sso: { enabled: false },
		pastDue: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	beforeEach(() => {
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_MONTHLY = 'seat-addon-monthly';
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_YEARLY = 'User-Seats-USD-Yearly';
		process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID_MONTHLY = 'sso-addon-monthly';
		process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID_YEARLY = 'sso-addon-yearly';
	});

	afterEach(() => {
		clearAddonEnv();
	});

	it('mirrors seat quantity and SSO add-on into limits', () => {
		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			billing_period: 1,
			billing_period_unit: 'month',
			current_term_start: 1_700_000_000,
			current_term_end: 1_702_592_000,
			resource_version: 10,
			subscription_items: [
				{ item_price_id: 'platform-monthly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'seat-addon-monthly', item_type: 'addon', quantity: 12 },
				{ item_price_id: 'sso-addon-monthly', item_type: 'addon', quantity: 1 },
			],
		});

		expect(update.limits?.seats).toBe(12);
		expect(update.limits?.ssoAllowed).toBe(true);
		expect(update.sso?.enabled).toBe(true);
		expect(update.chargebee?.subscriptionId).toBe('sub_123');
		expect(update.chargebee?.resourceVersion).toBe(10);
		expect(update.billingCadence).toBe('monthly');
	});

	it('resolves seats from configured yearly item price ID', () => {
		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			subscription_items: [
				{ item_price_id: 'uprevit-platform-USD-Yearly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'User-Seats-USD-Yearly', item_type: 'addon', quantity: 5 },
			],
		});

		expect(update.limits?.seats).toBe(5);
	});

	it('keeps fallback seats when configured IDs do not match subscription items', () => {
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_MONTHLY = 'wrong-seat-addon-id';
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_YEARLY = 'also-wrong';

		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			subscription_items: [
				{ item_price_id: 'uprevit-platform-USD-Yearly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'User-Seats-USD-Yearly', item_type: 'addon', quantity: 9 },
			],
		});

		expect(update.limits?.seats).toBe(5);
	});

	it('keeps stored seat count when no seat item price IDs are configured', () => {
		clearAddonEnv();

		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			subscription_items: [
				{ item_price_id: 'uprevit-platform-USD-Yearly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'User-Seats-USD-Yearly', item_type: 'addon', quantity: 8 },
			],
		});

		expect(update.limits?.seats).toBe(5);
	});

	it('does not treat plan quantity as seat count', () => {
		clearAddonEnv();

		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			subscription_items: [
				{ item_price_id: 'uprevit-platform-USD-Yearly', item_type: 'plan', quantity: 1 },
			],
		});

		expect(update.limits?.seats).toBe(5);
	});

	it('matches SSO addon from yearly configured item price ID', () => {
		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			subscription_items: [
				{ item_price_id: 'platform-yearly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'sso-addon-yearly', item_type: 'addon', quantity: 1 },
			],
		});

		expect(update.limits?.ssoAllowed).toBe(true);
		expect(update.sso?.enabled).toBe(true);
	});

	it('marks past due when due_invoices_count is positive', () => {
		const update = buildChargebeeMirrorUpdate(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			due_invoices_count: 2,
		});

		expect(update.pastDue).toBe(true);
		expect(update.status).toBe('past_due');
	});

	it('clears past due when due_invoices_count is zero', () => {
		const update = buildChargebeeMirrorUpdate(
			{ ...baseAccount, pastDue: true, status: 'past_due' },
			{
				id: 'sub_123',
				customer_id: 'cust_123',
				status: 'active',
				due_invoices_count: 0,
			},
		);

		expect(update.pastDue).toBe(false);
		expect(update.status).toBe('active');
	});

	it('honors explicit invoicePastDue override', () => {
		const update = buildChargebeeMirrorUpdate(
			baseAccount,
			{
				id: 'sub_123',
				customer_id: 'cust_123',
				status: 'active',
				due_invoices_count: 0,
			},
			{ invoicePastDue: true },
		);

		expect(update.pastDue).toBe(true);
		expect(update.status).toBe('past_due');
	});

	it('handles legacy billing accounts without sso field', () => {
		const { sso: _sso, ...legacyAccount } = baseAccount;

		const update = buildChargebeeMirrorUpdate(legacyAccount as BillingAccount & { _id: ObjectId }, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			subscription_items: [
				{ item_price_id: 'platform-monthly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'sso-addon-monthly', item_type: 'addon', quantity: 1 },
			],
		});

		expect(update.sso?.enabled).toBe(true);
		expect(update.sso?.enabledAt).toBeInstanceOf(Date);
	});
});

describe('resolveSubscriptionSeatQuantity', () => {
	it('matches any configured seat item price ID', () => {
		const seats = resolveSubscriptionSeatQuantity(
			[
				{ item_price_id: 'platform-yearly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'seat-addon-yearly', item_type: 'addon', quantity: 7 },
			],
			['seat-addon-monthly', 'seat-addon-yearly'],
			3,
		);

		expect(seats).toBe(7);
	});
});

describe('stale Chargebee subscription webhooks', () => {
	const account: BillingAccount = {
		workspaceId: new ObjectId(),
		status: 'active',
		limits: {
			enabled: true,
			enforcementMode: 'overage',
			seats: 5,
			exports: 100,
			uploadGb: 10,
			ssoAllowed: false,
		},
		billingCadence: 'monthly',
		currency: 'USD',
		netTermDays: 30,
		paymentMode: 'offline_wire',
		sso: { enabled: false },
		pastDue: false,
		chargebee: { resourceVersion: 20 },
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('detects stale webhook subscription versions', () => {
		expect(isStaleChargebeeSubscriptionEvent(account, {
			id: 'sub_1',
			customer_id: 'cust_1',
			status: 'active',
			resource_version: 15,
		})).toBe(true);

		expect(isStaleChargebeeSubscriptionEvent(account, {
			id: 'sub_1',
			customer_id: 'cust_1',
			status: 'active',
			resource_version: 20,
		})).toBe(false);

		expect(isStaleChargebeeSubscriptionEvent(account, {
			id: 'sub_1',
			customer_id: 'cust_1',
			status: 'active',
			resource_version: 25,
		})).toBe(false);
	});

	it('retrieves latest subscription when webhook payload is stale', async () => {
		const staleSubscription = {
			id: 'sub_1',
			customer_id: 'cust_1',
			status: 'active',
			resource_version: 15,
			subscription_items: [
				{ item_price_id: 'platform-monthly', item_type: 'plan', quantity: 1 },
			],
		};
		const latestSubscription = {
			...staleSubscription,
			resource_version: 22,
			subscription_items: [
				{ item_price_id: 'platform-monthly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'seat-addon-monthly', item_type: 'addon', quantity: 9 },
			],
		};

		mockRetrieveChargebeeSubscription.mockResolvedValue(latestSubscription);

		await expect(resolveChargebeeSubscriptionForMirror(account, staleSubscription))
			.resolves.toEqual(latestSubscription);
		expect(mockRetrieveChargebeeSubscription).toHaveBeenCalledWith('sub_1');
	});

	it('uses webhook payload when version is current', async () => {
		const currentSubscription = {
			id: 'sub_1',
			customer_id: 'cust_1',
			status: 'active',
			resource_version: 25,
		};

		await expect(resolveChargebeeSubscriptionForMirror(account, currentSubscription))
			.resolves.toEqual(currentSubscription);
		expect(mockRetrieveChargebeeSubscription).not.toHaveBeenCalled();
	});
});

describe('syncPastDueFromChargebee', () => {
	const account: BillingAccount & { _id: ObjectId } = {
		_id: new ObjectId(),
		workspaceId: new ObjectId(),
		status: 'active',
		limits: {
			enabled: true,
			enforcementMode: 'overage',
			seats: 5,
			exports: 100,
			uploadGb: 10,
			ssoAllowed: false,
		},
		billingCadence: 'monthly',
		currency: 'USD',
		netTermDays: 30,
		paymentMode: 'offline_wire',
		sso: { enabled: false },
		pastDue: false,
		chargebee: {
			customerId: 'cust_123',
			subscriptionId: 'sub_123',
		},
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('uses open invoice balances instead of due_invoices_count', async () => {
		const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
		const findOne = jest.fn()
			.mockResolvedValueOnce(account)
			.mockResolvedValueOnce({ ...account, pastDue: true, status: 'past_due' });

		mockGetDb.mockResolvedValue({
			collection: jest.fn().mockReturnValue({
				findOne,
				updateOne,
			}),
		} as never);

		mockRetrieveChargebeeSubscription.mockResolvedValue({
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			due_invoices_count: 0,
		});

		mockListChargebeeInvoicesForCustomer.mockResolvedValue([
			{ id: 'inv_1', customer_id: 'cust_123', status: 'paid', amount_due: 0 },
			{ id: 'inv_2', customer_id: 'cust_123', status: 'payment_due', amount_due: 50 },
		]);

		await expect(syncPastDueFromChargebee('sub_123')).resolves.toBe(true);
		expect(mockListChargebeeInvoicesForCustomer).toHaveBeenCalledWith('cust_123');
		expect(updateOne).toHaveBeenCalledWith(
			{ _id: account._id },
			expect.objectContaining({
				$set: expect.objectContaining({
					pastDue: true,
					status: 'past_due',
				}),
			}),
		);
	});

	it('clears past due when invoices have no amount due despite due_invoices_count', async () => {
		const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
		const findOne = jest.fn()
			.mockResolvedValueOnce(account)
			.mockResolvedValueOnce({ ...account, pastDue: false, status: 'active' });

		mockGetDb.mockResolvedValue({
			collection: jest.fn().mockReturnValue({
				findOne,
				updateOne,
			}),
		} as never);

		mockRetrieveChargebeeSubscription.mockResolvedValue({
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			due_invoices_count: 1,
		});

		mockListChargebeeInvoicesForCustomer.mockResolvedValue([
			{ id: 'inv_1', customer_id: 'cust_123', status: 'paid', amount_due: 0 },
		]);

		await expect(syncPastDueFromChargebee('sub_123')).resolves.toBe(true);
		expect(updateOne).toHaveBeenCalledWith(
			{ _id: account._id },
			expect.objectContaining({
				$set: expect.objectContaining({
					pastDue: false,
					status: 'active',
				}),
			}),
		);
	});
});

describe('claimChargebeeWebhook', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns claimed on first insert', async () => {
		const insertOne = jest.fn().mockResolvedValue({ acknowledged: true });
		mockGetDb.mockResolvedValue({
			collection: jest.fn().mockReturnValue({
				createIndex: jest.fn().mockResolvedValue(undefined),
				insertOne,
			}),
		} as never);

		await expect(claimChargebeeWebhook('evt_1', 'invoice_generated')).resolves.toBe('claimed');
		expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt_1' }));
	});

	it('returns duplicate on unique index conflict', async () => {
		const insertOne = jest.fn().mockRejectedValue({ code: 11000 });
		mockGetDb.mockResolvedValue({
			collection: jest.fn().mockReturnValue({
				createIndex: jest.fn().mockResolvedValue(undefined),
				insertOne,
			}),
		} as never);

		await expect(claimChargebeeWebhook('evt_1', 'invoice_generated')).resolves.toBe('duplicate');
	});
});
