import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { serializeBillingAccount } from '../../utils/billing/serializers';
import { isChargebeeConfigured } from '../../config/chargebeeConfig';
import {
	retrieveChargebeeSubscription,
	updateChargebeeSubscriptionOfflineBilling,
} from '../../utils/billing/chargebeeClient';
import { applyChargebeeSubscriptionMirror } from '../../utils/billing/chargebeeWebhooks';
import { retryPendingUsageEventsForWorkspace } from '../../utils/billing/usageEventChargebeeSync';

/**
 * Links a Chargebee subscription to a workspace billing account.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Subscription linked payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		if (!isChargebeeConfigured()) {
			return ResponseWrapper.badRequest('Chargebee is not configured');
		}

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input: { subscriptionId?: string };
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const subscriptionId = input.subscriptionId?.trim();
		if (!subscriptionId) {
			return ResponseWrapper.badRequest('subscriptionId is required');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const account = await getBillingAccountByWorkspaceId(workspaceObjectId);
		if (!account) return ResponseWrapper.notFound('Billing account not found');

		const subscription = await retrieveChargebeeSubscription(subscriptionId);
		if (account.chargebee?.customerId && subscription.customer_id !== account.chargebee.customerId) {
			return ResponseWrapper.badRequest('Subscription does not belong to the linked Chargebee customer');
		}

		await updateChargebeeSubscriptionOfflineBilling(subscriptionId);
		const refreshed = await retrieveChargebeeSubscription(subscriptionId);
		const mirrored = await applyChargebeeSubscriptionMirror({
			account,
			subscription: refreshed,
		});

		const retried = await retryPendingUsageEventsForWorkspace(workspaceObjectId, mirrored);

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'billing.account.update',
			targetType: 'billing_account',
			workspaceId: workspaceObjectId,
			entityId: mirrored._id.toString(),
			summary: `Linked Chargebee subscription for ${workspace.workspaceName}`,
			changes: [{ path: 'chargebee.subscriptionId', to: subscriptionId }],
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Chargebee subscription linked',
			data: {
				subscriptionId,
				account: serializeBillingAccount(mirrored),
				retriedUsageEvents: retried,
			},
		});
	} catch (error) {
		logError('Platform admin link Chargebee subscription failed', error);
		return ResponseWrapper.internalServerError('Failed to link Chargebee subscription');
	}
};
