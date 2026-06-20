import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { getWorkspaceInvoiceAccess } from '../../utils/billing/invoiceAccess';
import { serializeInvoiceDetail } from '../../utils/billing/invoiceSerializers';

/**
 * Returns a single Chargebee invoice for a workspace (platform admin).
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Invoice detail payload
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
			return ResponseWrapper.badRequest("'invoiceId' is required in path parameters");
		}

		const access = await getWorkspaceInvoiceAccess({
			workspaceId: new ObjectId(workspaceId),
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
		logError('Platform admin get billing invoice failed', error);
		return ResponseWrapper.internalServerError('Failed to retrieve invoice');
	}
};
