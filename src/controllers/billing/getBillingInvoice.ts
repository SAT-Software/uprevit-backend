import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { getWorkspaceInvoiceAccess } from '../../utils/billing/invoiceAccess';
import { serializeInvoiceDetail } from '../../utils/billing/invoiceSerializers';

/**
 * Returns a single Chargebee invoice with full details for the workspace.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Invoice detail payload
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
			return ResponseWrapper.badRequest("'invoiceId' is required in path parameters");
		}

		const access = await getWorkspaceInvoiceAccess({
			workspaceId: context.workspaceId,
			invoiceId,
		});
		if (!access.ok) return access.response;

		return ResponseWrapper.success({
			message: 'Invoice retrieved',
			data: {
				invoice: serializeInvoiceDetail(access.invoice),
			},
		});
	} catch (error) {
		logError('Get billing invoice failed', error);
		return ResponseWrapper.internalServerError('Failed to retrieve invoice');
	}
};
