import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { getWorkspaceInvoiceAccess } from '../../utils/billing/invoiceAccess';
import { retrieveChargebeeInvoicePdf } from '../../utils/billing/chargebeeClient';
import { serializeInvoicePdfDownload } from '../../utils/billing/invoiceSerializers';

/**
 * Returns a Chargebee invoice PDF download URL for a workspace invoice.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Invoice download payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event, { allowAccessFrozen: true });
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		const invoiceId = event.pathParameters?.invoiceId?.trim();
		if (!invoiceId) {
			return ResponseWrapper.badRequest("Invoice id - 'invoiceId' is required in path parameters");
		}

		const access = await getWorkspaceInvoiceAccess({
			workspaceId: context.workspaceId,
			invoiceId,
		});
		if (!access.ok) return access.response;

		let download;
		try {
			download = await retrieveChargebeeInvoicePdf(invoiceId);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to download invoice';
			if (message.includes('resource_not_found') || message.includes('not found')) {
				return ResponseWrapper.notFound('Invoice download not available');
			}

			logError('Chargebee invoice PDF download failed', error, {
				workspaceId: context.workspaceId.toString(),
				invoiceId,
			});
			return ResponseWrapper.internalServerError('Failed to download invoice');
		}

		return ResponseWrapper.success({
			message: 'Invoice PDF download URL retrieved',
			data: {
				invoiceId,
				...serializeInvoicePdfDownload(download),
			},
		});
	} catch (error) {
		logError('Download billing invoice failed', error);
		return ResponseWrapper.internalServerError('Failed to download invoice');
	}
};
