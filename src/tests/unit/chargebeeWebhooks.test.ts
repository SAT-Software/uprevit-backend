import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { buildChargebeeMirrorUpdate } from '../../utils/billing/chargebeeWebhooks';
import type { BillingAccount } from '../../models/billing';
import { ObjectId } from 'mongodb';

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
});
