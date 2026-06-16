import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ObjectId } from 'mongodb';
import type { BillingAccount } from '../../models/billing';
import {
	applyLiveChargebeeToSerializedAccount,
	resolveInvoicePastDue,
	resolveInvoicePastDueFromInvoices,
} from '../../utils/billing/chargebeeBillingDetail';

describe('chargebeeBillingDetail', () => {
	const baseAccount: BillingAccount & { _id: ObjectId } = {
		_id: new ObjectId(),
		workspaceId: new ObjectId(),
		status: 'past_due',
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
		pastDue: true,
		chargebee: {
			customerId: 'cust_123',
			subscriptionId: 'sub_123',
			subscriptionStatus: 'future',
			planId: 'platform-monthly',
			currentTermStart: new Date('2024-01-01'),
			currentTermEnd: new Date('2024-02-01'),
			nextBillingAt: new Date('2024-02-01'),
		},
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

	it('resolves invoice past due from due_invoices_count when invoices are unavailable', () => {
		expect(resolveInvoicePastDue({ id: 'sub_1', customer_id: 'cust_1', status: 'active', due_invoices_count: 1 }))
			.toBe(true);
		expect(resolveInvoicePastDue({ id: 'sub_1', customer_id: 'cust_1', status: 'active', due_invoices_count: 0 }))
			.toBe(false);
	});

	it('prefers invoice balances over stale due_invoices_count', () => {
		const subscription = {
			id: 'sub_1',
			customer_id: 'cust_1',
			status: 'active',
			due_invoices_count: 1,
		};

		expect(resolveInvoicePastDue(subscription, [
			{ id: 'inv_1', customer_id: 'cust_1', status: 'paid', amount_due: 0, total: 100 },
		])).toBe(false);

		expect(resolveInvoicePastDueFromInvoices([
			{ id: 'inv_2', customer_id: 'cust_1', status: 'payment_due', amount_due: 50, total: 50 },
		])).toBe(true);
	});

	it('clears stale past due and subscription status from live Chargebee data', () => {
		const serialized = applyLiveChargebeeToSerializedAccount(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			due_invoices_count: 0,
			billing_period_unit: 'month',
			current_term_start: 1_700_000_000,
			current_term_end: 1_702_592_000,
			next_billing_at: 1_702_592_000,
			subscription_items: [
				{ item_price_id: 'platform-monthly', item_type: 'plan', quantity: 1 },
			],
		});

		expect(serialized.pastDue).toBe(false);
		expect(serialized.status).toBe('active');
		expect(serialized.chargebee?.subscriptionStatus).toBe('active');
	});

	it('preserves stored SSO state on live Chargebee reads when addon is absent', () => {
		const accountWithSso: BillingAccount & { _id: ObjectId } = {
			...baseAccount,
			sso: {
				enabled: true,
				enabledAt: new Date('2025-01-01'),
			},
		};

		const serialized = applyLiveChargebeeToSerializedAccount(accountWithSso, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			due_invoices_count: 0,
			billing_period_unit: 'month',
			current_term_start: 1_700_000_000,
			current_term_end: 1_702_592_000,
			subscription_items: [
				{ item_price_id: 'platform-monthly', item_type: 'plan', quantity: 1 },
			],
		});

		expect(serialized.sso.enabled).toBe(true);
	});

	it('mirrors seat quantity from Chargebee subscription items on live reads', () => {
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID = 'wrong-seat-addon-id';

		const serialized = applyLiveChargebeeToSerializedAccount(baseAccount, {
			id: 'sub_123',
			customer_id: 'cust_123',
			status: 'active',
			due_invoices_count: 0,
			billing_period_unit: 'year',
			current_term_start: 1_700_000_000,
			current_term_end: 1_702_592_000,
			subscription_items: [
				{ item_price_id: 'uprevit-platform-USD-Yearly', item_type: 'plan', quantity: 1 },
				{ item_price_id: 'User-Seats-USD-Yearly', item_type: 'addon', quantity: 5 },
			],
		});

		expect(serialized.usageLimits.seats).toBe(5);
	});
});
