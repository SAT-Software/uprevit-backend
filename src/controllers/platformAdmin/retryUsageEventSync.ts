import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { serializeUsageEvent } from '../../utils/billing/serializers';
import {
	retryPendingUsageEventsForWorkspace,
	retryUsageEventSyncById,
} from '../../utils/billing/usageEventChargebeeSync';

/**
 * Manually retries Chargebee sync for one usage event or all retryable events in a workspace.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Retry result payload
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

		const eventId = event.pathParameters?.eventId;
		const { auth, operator } = operatorResult.context;

		if (eventId) {
			if (!ObjectId.isValid(eventId)) {
				return ResponseWrapper.badRequest('eventId must be a valid ObjectId');
			}

			const updated = await retryUsageEventSyncById({
				workspaceId: workspaceObjectId,
				eventId: new ObjectId(eventId),
				account,
			});

			await recordPlatformAuditEvent({
				action: 'chargebee.usage.sync',
				targetType: 'usage_event',
				workspaceId: workspaceObjectId,
				entityId: eventId,
				summary: `Retried Chargebee sync for usage event in ${workspace.workspaceName}`,
				auth: auth.payload,
				operator,
				event,
				source: 'platform-admin-portal',
			});

			return ResponseWrapper.success({
				message: 'Usage event sync retried',
				data: serializeUsageEvent(updated),
			});
		}

		const retried = await retryPendingUsageEventsForWorkspace(workspaceObjectId, account);

		await recordPlatformAuditEvent({
			action: 'chargebee.usage.sync',
			targetType: 'billing_account',
			workspaceId: workspaceObjectId,
			entityId: account._id.toString(),
			summary: `Retried Chargebee sync for ${retried} usage events in ${workspace.workspaceName}`,
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Usage event sync retried',
			data: { retried },
		});
	} catch (error) {
		logError('Platform admin retry usage event sync failed', error);
		const message = error instanceof Error ? error.message : 'Failed to retry usage event sync';
		if (message.includes('not found') || message.includes('not syncable')) {
			return ResponseWrapper.badRequest(message);
		}
		return ResponseWrapper.internalServerError('Failed to retry usage event sync');
	}
};
