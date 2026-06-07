import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { recomputeUsageSnapshot } from '../../utils/billing/snapshots';
import { serializeUsageSnapshot } from '../../utils/billing/serializers';

/**
 * Recomputes the current billing period usage snapshot for a workspace.
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

		const snapshot = await recomputeUsageSnapshot({
			workspaceId: workspaceObjectId,
			billingAccount: account,
		});

		return ResponseWrapper.success({
			message: 'Usage snapshot recomputed',
			data: serializeUsageSnapshot(snapshot),
		});
	} catch (error) {
		logError('Platform admin recompute usage snapshot failed', error);
		return ResponseWrapper.internalServerError('Failed to recompute usage snapshot');
	}
};
