import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getWorkspaceInvoiceAccess } from '../../utils/billing/invoiceAccess';
import { recordChargebeeInvoicePayment } from '../../utils/billing/chargebeeClient';
import { syncPastDueFromChargebee } from '../../utils/billing/chargebeeWebhooks';
import { serializeInvoiceDetail } from '../../utils/billing/invoiceSerializers';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Records an offline bank transfer for the full amount due on a workspace's Chargebee invoice (platform admin).
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Updated invoice detail payload
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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

		let input: { referenceNumber?: unknown };
		try {
			input = JSON.parse(event.body || '{}');
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}
		const referenceNumber = typeof input.referenceNumber === 'string' && input.referenceNumber.trim()
			? input.referenceNumber.trim().slice(0, 100)
			: undefined;

		const workspaceObjectId = new ObjectId(workspaceId);
		const access = await getWorkspaceInvoiceAccess({ workspaceId: workspaceObjectId, invoiceId });
		if (!access.ok) return access.response;

		const amountDue = access.invoice.amount_due ?? 0;
		if (amountDue <= 0) return ResponseWrapper.badRequest('This invoice has nothing left to pay');

		const invoice = await recordChargebeeInvoicePayment(invoiceId, { amount: amountDue, referenceNumber });
		if (invoice.subscription_id) await syncPastDueFromChargebee(invoice.subscription_id);

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'billing.invoice.record_payment',
			targetType: 'billing_account',
			workspaceId: workspaceObjectId,
			entityId: invoiceId,
			summary: `Recorded payment of ${(amountDue / 100).toFixed(2)} ${invoice.currency_code ?? ''} for invoice ${invoiceId}`.trim(),
			changes: [{ path: 'invoice.amountDue', from: amountDue, to: invoice.amount_due ?? 0 }],
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Invoice marked as paid',
			data: { invoice: serializeInvoiceDetail(invoice) },
		});
	} catch (error) {
		logError('Platform admin record invoice payment failed', error);
		return ResponseWrapper.internalServerError('Failed to record invoice payment');
	}
});
