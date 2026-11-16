import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/billing/chargebeeWebhooks', () => ({
	...(jest.requireActual('../../utils/billing/chargebeeWebhooks') as object),
	claimChargebeeWebhook: jest.fn(async () => 'claimed'),
	completeChargebeeWebhookClaim: jest.fn(async () => undefined),
	releaseChargebeeWebhookClaim: jest.fn(async () => undefined),
	findBillingAccountByChargebeeSubscriptionId: jest.fn(async () => null),
	findBillingAccountByChargebeeCustomerId: jest.fn(async () => null),
	applyChargebeeSubscriptionMirror: jest.fn(async () => undefined),
	syncPastDueFromChargebee: jest.fn(async () => true),
}));

const webhooks = jest.requireMock('../../utils/billing/chargebeeWebhooks') as any;

const { lambdaHandler } = require('../../controllers/billing/chargebeeWebhook');

const buildEvent = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
	httpMethod: 'POST',
	path: '/billing/webhooks/chargebee',
	headers: { Authorization: `Basic ${Buffer.from('hook-user:hook-pass').toString('base64')}` },
	body: JSON.stringify(body),
	pathParameters: null,
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
} as APIGatewayProxyEvent);

describe('chargebeeWebhook handler input validation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		process.env.CHARGEBEE_WEBHOOK_USERNAME = 'hook-user';
		process.env.CHARGEBEE_WEBHOOK_PASSWORD = 'hook-pass';
	});

	it.each([
		['subscription id', { subscription: { id: { $ne: null }, customer_id: 'cus_1' } }, 'subscription_changed'],
		['customer id', { subscription: { id: 'sub_1', customer_id: { $ne: null } } }, 'subscription_changed'],
		['invoice subscription id', { invoice: { subscription_id: { $ne: null } } }, 'invoice_generated'],
	])('rejects an operator-shaped %s before claiming or writing', async (_label, content, eventType) => {
		const response = await lambdaHandler(buildEvent({ id: 'evt-poison-1', event_type: eventType, content }));

		expect(response.statusCode).toBe(400);
		expect(webhooks.claimChargebeeWebhook).not.toHaveBeenCalled();
		expect(webhooks.findBillingAccountByChargebeeSubscriptionId).not.toHaveBeenCalled();
		expect(webhooks.findBillingAccountByChargebeeCustomerId).not.toHaveBeenCalled();
		expect(webhooks.applyChargebeeSubscriptionMirror).not.toHaveBeenCalled();
		expect(webhooks.syncPastDueFromChargebee).not.toHaveBeenCalled();
	});

	it('looks up accounts with validated string ids', async () => {
		const response = await lambdaHandler(buildEvent({
			id: 'evt-1',
			event_type: 'subscription_changed',
			content: { subscription: { id: 'sub_1', customer_id: 'cus_1' } },
		}));

		expect(response.statusCode).toBe(500);
		expect(webhooks.findBillingAccountByChargebeeSubscriptionId).toHaveBeenCalledWith('sub_1');
		expect(webhooks.findBillingAccountByChargebeeCustomerId).toHaveBeenCalledWith('cus_1');
		expect(webhooks.applyChargebeeSubscriptionMirror).not.toHaveBeenCalled();
	});

	it('syncs past due for a valid invoice subscription id', async () => {
		const response = await lambdaHandler(buildEvent({
			id: 'evt-2',
			event_type: 'payment_succeeded',
			content: { invoice: { subscription_id: 'sub_1' } },
		}));

		expect(response.statusCode).toBe(200);
		expect(webhooks.syncPastDueFromChargebee).toHaveBeenCalledWith('sub_1');
	});

	it('ignores operator-shaped values on events it does not process', async () => {
		const response = await lambdaHandler(buildEvent({
			id: 'evt-3',
			event_type: 'customer_changed',
			content: { subscription: { id: { $ne: null } } },
		}));

		expect(response.statusCode).toBe(200);
		expect(webhooks.findBillingAccountByChargebeeSubscriptionId).not.toHaveBeenCalled();
	});
});
