import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import {
	createBillingAccountForWorkspace,
	getBillingAccountByWorkspaceId,
} from '../../utils/billing/billingAccounts';
import {
	buildBillingSummary,
	serializeBillingAccount,
	serializeUsageSnapshot,
	serializeWorkspaceFreezes,
} from '../../utils/billing/serializers';
import { getCurrentUsageSnapshot } from '../../utils/billing/snapshots';

/**
 * Creates a draft billing account for a workspace that does not have one yet.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Billing account created payload
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

		const existing = await getBillingAccountByWorkspaceId(workspaceObjectId);
		const created = !existing;
		const account = existing ?? (await createBillingAccountForWorkspace(workspaceObjectId));

		const snapshot = await getCurrentUsageSnapshot({
			workspaceId: workspaceObjectId,
			billingAccount: account,
			recomputeIfStale: created,
		});

		const summary = await buildBillingSummary({
			account,
			workspaceId: workspaceObjectId,
		});

		const { auth, operator } = operatorResult.context;
		if (created) {
			await recordPlatformAuditEvent({
				action: 'billing.account.update',
				targetType: 'billing_account',
				workspaceId: workspaceObjectId,
				entityId: account._id.toString(),
				summary: `Created billing account for ${workspace.workspaceName}`,
				changes: [{ path: 'status', to: account.status }],
				auth: auth.payload,
				operator,
				event,
				source: 'platform-admin-portal',
			});
		}

		return ResponseWrapper.success({
			message: created ? 'Billing account created' : 'Billing account already exists',
			data: {
				account: serializeBillingAccount(account),
				summary,
				snapshot: snapshot?._id ? serializeUsageSnapshot(snapshot) : null,
				freezes: serializeWorkspaceFreezes(workspace),
			},
		});
	} catch (error) {
		logError('Platform admin create billing account failed', error);
		return ResponseWrapper.internalServerError('Failed to create billing account');
	}
};
