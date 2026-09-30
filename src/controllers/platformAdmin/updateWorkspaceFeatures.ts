import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';

/**
 * Updates per-workspace feature flags.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Updated workspace feature flags
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		let input: { approvalWorkflowsEnabled?: unknown };
		try {
			input = JSON.parse(event.body ?? '');
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		if (typeof input.approvalWorkflowsEnabled !== 'boolean') {
			return ResponseWrapper.badRequest('approvalWorkflowsEnabled must be a boolean');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOneAndUpdate(
			{ _id: workspaceObjectId },
			{ $set: { approvalWorkflowsEnabled: input.approvalWorkflowsEnabled } },
		);
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'workspace.features.update',
			targetType: 'workspace',
			workspaceId: workspaceObjectId,
			entityId: workspaceId,
			summary: `${input.approvalWorkflowsEnabled ? 'Enabled' : 'Disabled'} approval workflows for ${workspace.workspaceName}`,
			changes: [{
				path: 'approvalWorkflowsEnabled',
				from: workspace.approvalWorkflowsEnabled ?? false,
				to: input.approvalWorkflowsEnabled,
			}],
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Workspace features updated',
			data: { approvalWorkflowsEnabled: input.approvalWorkflowsEnabled },
		});
	} catch (error) {
		logError('Platform admin update workspace features failed', error);
		return ResponseWrapper.internalServerError('Failed to update workspace features');
	}
};
