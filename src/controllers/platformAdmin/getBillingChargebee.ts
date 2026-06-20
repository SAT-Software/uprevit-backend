import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { buildChargebeeBillingDetail } from '../../utils/billing/chargebeeBillingDetail';

/**
 * Returns Chargebee billing detail and invoices for a workspace (platform admin).
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Chargebee billing payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const account = await getBillingAccountByWorkspaceId(workspaceObjectId);
		if (!account) return ResponseWrapper.notFound('Billing account not found');

		const detail = await buildChargebeeBillingDetail(account);

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'billing.chargebee.view',
			targetType: 'billing_account',
			workspaceId: workspaceObjectId,
			entityId: account._id.toString(),
			summary: `Viewed Chargebee billing for ${workspace.workspaceName}`,
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Chargebee billing retrieved',
			data: detail,
		});
	} catch (error) {
		logError('Platform admin get billing chargebee failed', error);
		return ResponseWrapper.internalServerError('Failed to load billing information');
	}
};
