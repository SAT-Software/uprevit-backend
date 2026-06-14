import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { serializeBillingAccount } from '../../utils/billing/serializers';
import { isChargebeeConfigured } from '../../config/chargebeeConfig';
import { listChargebeeInvoicesForCustomer } from '../../utils/billing/chargebeeClient';
import { serializeInvoiceSummary } from '../../utils/billing/invoiceSerializers';

const serializeInvoice = serializeInvoiceSummary;

/**
 * Returns mirrored Chargebee profile and on-demand invoices for the Billing tab.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Chargebee billing payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event, { allowAccessFrozen: true });
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		const account = await getBillingAccountByWorkspaceId(context.workspaceId);
		if (!account) {
			return ResponseWrapper.notFound('Billing account not found');
		}

		const customerId = account.chargebee?.customerId?.trim();
		let invoices: ReturnType<typeof serializeInvoice>[] = [];
		let invoiceError: string | null = null;

		if (customerId && isChargebeeConfigured()) {
			try {
				const fetched = await listChargebeeInvoicesForCustomer(customerId);
				invoices = fetched.map(serializeInvoice);
			} catch (error) {
				invoiceError = error instanceof Error ? error.message : 'Failed to fetch invoices';
				logError('Chargebee invoice fetch failed', error, {
					workspaceId: context.workspaceId.toString(),
					customerId,
				});
			}
		}

		return ResponseWrapper.success({
			message: 'Chargebee billing retrieved',
			data: {
				account: serializeBillingAccount(account),
				connection: {
					configured: isChargebeeConfigured(),
					linked: Boolean(account.chargebee?.subscriptionId),
					customerId: customerId ?? null,
					subscriptionId: account.chargebee?.subscriptionId ?? null,
				},
				invoices,
				invoiceError,
			},
		});
	} catch (error) {
		logError('Get billing chargebee failed', error);
		return ResponseWrapper.internalServerError('Failed to load billing information');
	}
};
