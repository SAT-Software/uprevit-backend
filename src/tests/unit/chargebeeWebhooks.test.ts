import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
	buildChargebeeMirrorUpdate,
	claimChargebeeWebhook,
} from '../../utils/billing/chargebeeWebhooks';
import type { BillingAccount } from '../../models/billing';
import { ObjectId } from 'mongodb';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

import { getDb } from '../../utils/db';

const mockGetDb = getDb as jest.MockedFunction<typeof getDb>;

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
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID = 'seat-addon-monthly';
		process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID = 'sso-addon-monthly';
	});

	afterEach(() => {
		delete process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID;
		delete process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID;
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
		expect(update.billingCadence).toBe('monthly');
	});

	it('resolves seats from addon item_price_id containing seat when configured id mismatches', () => {
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID = 'wrong-seat-addon-id';

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

	it('does not treat plan quantity as seat count', () => {
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID = '';

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
