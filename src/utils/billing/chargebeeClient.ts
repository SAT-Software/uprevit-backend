import {
	getChargebeeApiKey,
	getChargebeeSite,
	isChargebeeConfigured,
} from '../../config/chargebeeConfig';

type ChargebeeListResponse<T> = {
	list: Array<{ [key: string]: T }>;
	next_offset?: string;
};

type ChargebeeEntityResponse<T> = {
	[key: string]: T;
};

const getBaseUrl = (): string => {
	const site = getChargebeeSite();
	if (!site) throw new Error('Chargebee is not configured');
	return `https://${site}.chargebee.com/api/v2`;
};

const getAuthHeader = (): string => {
	const apiKey = getChargebeeApiKey();
	if (!apiKey) throw new Error('Chargebee is not configured');
	return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
};

const encodeForm = (params: Record<string, string | number | boolean | undefined>): string => {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		body.set(key, String(value));
	}
	return body.toString();
};

const chargebeeRequest = async <T>({
	method,
	path,
	query,
	body,
}: {
	method: 'GET' | 'POST';
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: Record<string, string | number | boolean | undefined>;
}): Promise<T> => {
	if (!isChargebeeConfigured()) {
		throw new Error('Chargebee is not configured');
	}

	const url = new URL(`${getBaseUrl()}${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		method,
		headers: {
			Authorization: getAuthHeader(),
			Accept: 'application/json',
			...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
		},
		body: body ? encodeForm(body) : undefined,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(text || `Chargebee API request failed (${response.status})`);
	}

	return response.json() as Promise<T>;
};

export type ChargebeeCustomer = {
	id: string;
	company?: string;
	email?: string;
	auto_collection?: string;
};

export type ChargebeeSubscriptionItem = {
	item_price_id: string;
	item_type?: string;
	quantity?: number;
	unit_price?: number;
};

export type ChargebeeSubscription = {
	id: string;
	customer_id: string;
	status: string;
	plan_id?: string;
	plan_quantity?: number;
	billing_period?: number;
	billing_period_unit?: string;
	current_term_start?: number;
	current_term_end?: number;
	next_billing_at?: number;
	due_invoices_count?: number;
	subscription_items?: ChargebeeSubscriptionItem[];
};

export type ChargebeeInvoiceLineItem = {
	id: string;
	description?: string;
	amount?: number;
	unit_amount?: number;
	quantity?: number;
	date_from?: number;
	date_to?: number;
	entity_type?: string;
	entity_id?: string;
};

export type ChargebeeBillingAddress = {
	first_name?: string;
	last_name?: string;
	company?: string;
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	zip?: string;
	country?: string;
};

export type ChargebeeInvoice = {
	id: string;
	customer_id: string;
	subscription_id?: string;
	status: string;
	date?: number;
	due_date?: number;
	total?: number;
	amount_paid?: number;
	amount_due?: number;
	sub_total?: number;
	currency_code?: string;
	line_items?: ChargebeeInvoiceLineItem[];
	billing_address?: ChargebeeBillingAddress;
};

export type ChargebeeDownload = {
	download_url: string;
	mime_type?: string;
	valid_till?: number;
	object?: string;
};

export const createChargebeeCustomer = async ({
	id,
	company,
	email,
}: {
	id: string;
	company: string;
	email?: string;
}): Promise<ChargebeeCustomer> => {
	const result = await chargebeeRequest<ChargebeeEntityResponse<ChargebeeCustomer>>({
		method: 'POST',
		path: '/customers',
		body: {
			id,
			company,
			email,
			auto_collection: 'off',
		},
	});

	return result.customer;
};

export const retrieveChargebeeSubscription = async (
	subscriptionId: string,
): Promise<ChargebeeSubscription> => {
	const result = await chargebeeRequest<ChargebeeEntityResponse<ChargebeeSubscription>>({
		method: 'GET',
		path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
	});

	return result.subscription;
};

export const updateChargebeeSubscriptionOfflineBilling = async (
	subscriptionId: string,
): Promise<ChargebeeSubscription> => {
	const result = await chargebeeRequest<ChargebeeEntityResponse<ChargebeeSubscription>>({
		method: 'POST',
		path: `/subscriptions/${encodeURIComponent(subscriptionId)}/update_for_items`,
		body: {
			auto_collection: 'off',
			invoice_immediately: false,
		},
	});

	return result.subscription;
};

export const listChargebeeInvoicesForCustomer = async (
	customerId: string,
	limit = 100,
): Promise<ChargebeeInvoice[]> => {
	const invoices: ChargebeeInvoice[] = [];
	let offset: string | undefined;
	const maxPages = 10;

	for (let page = 0; page < maxPages; page += 1) {
		const result = await chargebeeRequest<ChargebeeListResponse<ChargebeeInvoice>>({
			method: 'GET',
			path: '/invoices',
			query: {
				'customer_id[is]': customerId,
				limit,
				'sort_by[desc]': 'date',
				...(offset ? { offset } : {}),
			},
		});

		invoices.push(...result.list.map((entry) => entry.invoice));
		if (!result.next_offset) break;
		offset = result.next_offset;
	}

	return invoices;
};

export const retrieveChargebeeInvoice = async (
	invoiceId: string,
): Promise<ChargebeeInvoice> => {
	const result = await chargebeeRequest<ChargebeeEntityResponse<ChargebeeInvoice>>({
		method: 'GET',
		path: `/invoices/${encodeURIComponent(invoiceId)}`,
	});

	return result.invoice;
};

export const retrieveChargebeeInvoicePdf = async (
	invoiceId: string,
): Promise<ChargebeeDownload> => {
	const result = await chargebeeRequest<{ download: ChargebeeDownload }>({
		method: 'POST',
		path: `/invoices/${encodeURIComponent(invoiceId)}/pdf`,
		body: {
			disposition_type: 'attachment',
		},
	});

	if (!result.download?.download_url) {
		throw new Error('Invoice PDF download not available');
	}

	return result.download;
};
