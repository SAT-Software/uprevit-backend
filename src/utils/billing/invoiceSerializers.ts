import type {
	ChargebeeBillingAddress,
	ChargebeeDownload,
	ChargebeeInvoice,
	ChargebeeInvoiceLineItem,
} from './chargebeeClient';

const toIsoDate = (unixSeconds?: number): string | null => (
	unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null
);

const serializeLineItem = (lineItem: ChargebeeInvoiceLineItem) => ({
	id: lineItem.id,
	description: lineItem.description ?? null,
	amount: lineItem.amount ?? 0,
	unitAmount: lineItem.unit_amount ?? 0,
	quantity: lineItem.quantity ?? 0,
	dateFrom: toIsoDate(lineItem.date_from),
	dateTo: toIsoDate(lineItem.date_to),
	entityType: lineItem.entity_type ?? null,
	entityId: lineItem.entity_id ?? null,
});

const serializeBillingAddress = (address?: ChargebeeBillingAddress) => {
	if (!address) return null;

	return {
		firstName: address.first_name ?? null,
		lastName: address.last_name ?? null,
		company: address.company ?? null,
		line1: address.line1 ?? null,
		line2: address.line2 ?? null,
		city: address.city ?? null,
		state: address.state ?? null,
		zip: address.zip ?? null,
		country: address.country ?? null,
	};
};

export const serializeInvoiceSummary = (invoice: ChargebeeInvoice) => ({
	id: invoice.id,
	status: invoice.status,
	date: toIsoDate(invoice.date),
	dueDate: toIsoDate(invoice.due_date),
	total: invoice.total ?? 0,
	amountPaid: invoice.amount_paid ?? 0,
	amountDue: invoice.amount_due ?? 0,
	currencyCode: invoice.currency_code ?? null,
	subscriptionId: invoice.subscription_id ?? null,
});

export const serializeInvoiceDetail = (invoice: ChargebeeInvoice) => ({
	...serializeInvoiceSummary(invoice),
	customerId: invoice.customer_id,
	subTotal: invoice.sub_total ?? 0,
	lineItems: (invoice.line_items ?? []).map(serializeLineItem),
	billingAddress: serializeBillingAddress(invoice.billing_address),
});

export const serializeInvoicePdfDownload = (download: ChargebeeDownload) => {
	const serialized = {
		downloadUrl: download.download_url,
		mimeType: download.mime_type ?? 'application/pdf',
		validTill: toIsoDate(download.valid_till),
	};

	return {
		downloads: [serialized],
		pdfDownloadUrl: download.download_url,
	};
};
