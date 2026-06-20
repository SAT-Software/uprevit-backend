import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/billing/billingAccounts', () => ({
	getBillingAccountByWorkspaceId: jest.fn(),
}));

jest.mock('../../utils/billing/chargebeeClient', () => ({
	retrieveChargebeeInvoice: jest.fn(),
	retrieveChargebeeInvoicePdf: jest.fn(),
}));

jest.mock('../../config/chargebeeConfig', () => ({
	isChargebeeConfigured: jest.fn(),
}));

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
	isWorkspaceAdmin: jest.fn(),
}));

const billingAccounts = jest.requireMock('../../utils/billing/billingAccounts') as any;
const chargebeeClient = jest.requireMock('../../utils/billing/chargebeeClient') as any;
const chargebeeConfig = jest.requireMock('../../config/chargebeeConfig') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;

const { getWorkspaceInvoiceAccess } = require('../../utils/billing/invoiceAccess');
const {
	serializeInvoiceDetail,
	serializeInvoicePdfDownload,
	serializeInvoiceSummary,
} = require('../../utils/billing/invoiceSerializers');
const { lambdaHandler: getBillingInvoice } = require('../../controllers/billing/getBillingInvoice');
const { lambdaHandler: downloadBillingInvoice } = require('../../controllers/billing/downloadBillingInvoice');

const workspaceId = new ObjectId();
const customerId = 'ws_69174ada552dcbbf657f8a91';

const sampleInvoice = {
	id: '1',
	customer_id: customerId,
	subscription_id: 'AzZTUCVMITOsAFvH',
	status: 'payment_due',
	date: 1781289000,
	due_date: 1781289000,
	total: 300000,
	amount_paid: 0,
	amount_due: 300000,
	sub_total: 300000,
	currency_code: 'USD',
	line_items: [
		{
			id: 'li_1',
			description: 'Monthly plan',
			amount: 300000,
			unit_amount: 300000,
			quantity: 1,
			date_from: 1781289000,
			date_to: 1783881000,
			entity_type: 'plan_item_price',
			entity_id: 'plan-usd',
		},
	],
	billing_address: {
		first_name: 'Jane',
		last_name: 'Doe',
		company: 'Acme',
		line1: '123 Main St',
		city: 'Boston',
		state: 'MA',
		zip: '02101',
		country: 'US',
	},
};

const buildEvent = (invoiceId?: string): APIGatewayProxyEvent => ({
	httpMethod: 'GET',
	path: invoiceId ? `/billing/invoices/${invoiceId}` : '/billing/invoices',
	headers: { Authorization: 'Bearer token' },
	body: null,
	pathParameters: invoiceId ? { invoiceId } : null,
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
} as APIGatewayProxyEvent);

describe('invoice serializers', () => {
	it('serializes invoice summary fields', () => {
		const summary = serializeInvoiceSummary(sampleInvoice);

		expect(summary).toEqual({
			id: '1',
			status: 'payment_due',
			date: '2026-06-12T18:30:00.000Z',
			dueDate: '2026-06-12T18:30:00.000Z',
			total: 300000,
			amountPaid: 0,
			amountDue: 300000,
			currencyCode: 'USD',
			subscriptionId: 'AzZTUCVMITOsAFvH',
		});
	});

	it('serializes invoice detail with line items and billing address', () => {
		const detail = serializeInvoiceDetail(sampleInvoice);

		expect(detail.customerId).toBe(customerId);
		expect(detail.subTotal).toBe(300000);
		expect(detail.lineItems).toHaveLength(1);
		expect(detail.billingAddress).toEqual({
			firstName: 'Jane',
			lastName: 'Doe',
			company: 'Acme',
			line1: '123 Main St',
			line2: null,
			city: 'Boston',
			state: 'MA',
			zip: '02101',
			country: 'US',
		});
	});

	it('serializes invoice pdf download url', () => {
		const download = serializeInvoicePdfDownload({
			download_url: 'https://example.com/invoice.pdf',
			mime_type: 'application/pdf',
			valid_till: 1781289000,
		});

		expect(download.pdfDownloadUrl).toBe('https://example.com/invoice.pdf');
		expect(download.downloads).toHaveLength(1);
		expect(download.downloads[0].mimeType).toBe('application/pdf');
	});
});

describe('getWorkspaceInvoiceAccess', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		chargebeeConfig.isChargebeeConfigured.mockReturnValue(true);
		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			chargebee: { customerId },
		});
		chargebeeClient.retrieveChargebeeInvoice.mockResolvedValue(sampleInvoice);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('returns invoice when it belongs to the workspace customer', async () => {
		const result = await getWorkspaceInvoiceAccess({
			workspaceId,
			invoiceId: '1',
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.invoice.id).toBe('1');
			expect(result.customerId).toBe(customerId);
		}
	});

	it('rejects invoices that belong to another customer', async () => {
		chargebeeClient.retrieveChargebeeInvoice.mockResolvedValue({
			...sampleInvoice,
			customer_id: 'other-customer',
		});

		const result = await getWorkspaceInvoiceAccess({
			workspaceId,
			invoiceId: '1',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.statusCode).toBe(404);
		}
	});

	it('requires a linked Chargebee customer', async () => {
		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			chargebee: {},
		});

		const result = await getWorkspaceInvoiceAccess({
			workspaceId,
			invoiceId: '1',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.statusCode).toBe(400);
		}
	});
});

describe('billing invoice controllers', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId, cognitoGroups: ['workspace-admin'] },
		});
		tenantContext.isWorkspaceAdmin.mockReturnValue(true);
		chargebeeConfig.isChargebeeConfigured.mockReturnValue(true);
		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			chargebee: { customerId },
		});
		chargebeeClient.retrieveChargebeeInvoice.mockResolvedValue(sampleInvoice);
		chargebeeClient.retrieveChargebeeInvoicePdf.mockResolvedValue({
			download_url: 'https://example.com/invoice.pdf',
			mime_type: 'application/pdf',
			valid_till: 1781289000,
		});
	});

	it('returns invoice details for workspace admins', async () => {
		const response = await getBillingInvoice(buildEvent('1'));
		const body = JSON.parse(response.body);

		expect(response.statusCode).toBe(200);
		expect(body.data.invoice.id).toBe('1');
		expect(body.data.invoice.lineItems).toHaveLength(1);
	});

	it('returns pdf download url for workspace admins', async () => {
		const response = await downloadBillingInvoice(buildEvent('1'));
		const body = JSON.parse(response.body);

		expect(response.statusCode).toBe(200);
		expect(body.data.invoiceId).toBe('1');
		expect(body.data.pdfDownloadUrl).toBe('https://example.com/invoice.pdf');
	});

	it('rejects non-workspace admins', async () => {
		tenantContext.isWorkspaceAdmin.mockReturnValue(false);

		const response = await getBillingInvoice(buildEvent('1'));

		expect(response.statusCode).toBe(403);
	});

	it('requires invoice id in path', async () => {
		const response = await getBillingInvoice(buildEvent());

		expect(response.statusCode).toBe(400);
	});
});
