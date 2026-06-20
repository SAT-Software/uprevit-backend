import { ObjectId } from 'mongodb';
import { APIGatewayProxyResult } from 'aws-lambda';
import { isChargebeeConfigured } from '../../config/chargebeeConfig';
import { ResponseWrapper } from '../responseWrapper';
import { getBillingAccountByWorkspaceId } from './billingAccounts';
import { retrieveChargebeeInvoice, type ChargebeeInvoice } from './chargebeeClient';

type InvoiceAccessResult =
	| { ok: true; customerId: string; invoice: ChargebeeInvoice }
	| { ok: false; response: APIGatewayProxyResult };

export const getWorkspaceInvoiceAccess = async ({
	workspaceId,
	invoiceId,
}: {
	workspaceId: ObjectId;
	invoiceId: string;
}): Promise<InvoiceAccessResult> => {
	const account = await getBillingAccountByWorkspaceId(workspaceId);
	if (!account) {
		return { ok: false, response: ResponseWrapper.notFound('Billing account not found') };
	}

	if (!isChargebeeConfigured()) {
		return {
			ok: false,
			response: ResponseWrapper.badRequest('Chargebee billing is not configured'),
		};
	}

	const customerId = account.chargebee?.customerId?.trim();
	if (!customerId) {
		return {
			ok: false,
			response: ResponseWrapper.badRequest('Workspace is not linked to Chargebee billing'),
		};
	}

	let invoice: ChargebeeInvoice;
	try {
		invoice = await retrieveChargebeeInvoice(invoiceId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to retrieve invoice';
		if (message.includes('resource_not_found') || message.includes('not found')) {
			return { ok: false, response: ResponseWrapper.notFound('Invoice not found') };
		}

		return {
			ok: false,
			response: ResponseWrapper.internalServerError('Failed to retrieve invoice'),
		};
	}

	if (invoice.customer_id !== customerId) {
		return { ok: false, response: ResponseWrapper.notFound('Invoice not found') };
	}

	return { ok: true, customerId, invoice };
};
