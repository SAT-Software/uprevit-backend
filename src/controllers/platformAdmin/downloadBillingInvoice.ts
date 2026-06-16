import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { getWorkspaceInvoiceAccess } from '../../utils/billing/invoiceAccess';
import { retrieveChargebeeInvoicePdf } from '../../utils/billing/chargebeeClient';
import { serializeInvoicePdfDownload } from '../../utils/billing/invoiceSerializers';

/**
 * Returns a Chargebee invoice PDF download URL for a workspace (platform admin).
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Invoice download payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		const invoiceId = event.pathParameters?.invoiceId?.trim();
		if (!invoiceId) {
			return ResponseWrapper.badRequest("Invoice id - 'invoiceId' is required in path parameters");
		}

		const access = await getWorkspaceInvoiceAccess({
			workspaceId: new ObjectId(workspaceId),
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
				workspaceId,
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
		logError('Platform admin download billing invoice failed', error);
		return ResponseWrapper.internalServerError('Failed to download invoice');
	}
};
