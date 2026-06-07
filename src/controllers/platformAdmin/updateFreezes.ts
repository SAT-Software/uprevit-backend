import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { serializeWorkspaceFreezes } from '../../utils/billing/serializers';

type FreezeInput = {
	usageFreezeEnabled?: boolean;
	accessFreezeEnabled?: boolean;
};

/**
 * Updates workspace usage and access freeze flags.
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input: FreezeInput;
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		if (typeof input.usageFreezeEnabled !== 'boolean' && typeof input.accessFreezeEnabled !== 'boolean') {
			return ResponseWrapper.badRequest('At least one freeze flag is required');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const now = new Date();
		const { operator } = operatorResult.context;
		const updates: Record<string, unknown> = {};

		if (typeof input.usageFreezeEnabled === 'boolean') {
			updates.workspaceUsageFreeze = {
				enabled: input.usageFreezeEnabled,
				updatedAt: now,
				updatedByPlatformAdminId: operator._id,
			};
		}
		if (typeof input.accessFreezeEnabled === 'boolean') {
			updates.workspaceAccessFreeze = {
				enabled: input.accessFreezeEnabled,
				updatedAt: now,
				updatedByPlatformAdminId: operator._id,
			};
		}

		const updated = await db.collection<Workspace>('workspaces').findOneAndUpdate(
			{ _id: workspaceObjectId },
			{ $set: updates },
			{ returnDocument: 'after' },
		);

		if (!updated) return ResponseWrapper.notFound('Workspace not found');

		const { auth } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'workspace.freeze.update',
			targetType: 'workspace',
			workspaceId: workspaceObjectId,
			entityId: workspaceObjectId.toString(),
			summary: `Updated workspace freezes for ${workspace.workspaceName}`,
			changes: Object.entries(updates).map(([path, value]) => ({ path, to: value })),
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Workspace freezes updated',
			data: serializeWorkspaceFreezes(updated),
		});
	} catch (error) {
		logError('Platform admin update freezes failed', error);
		return ResponseWrapper.internalServerError('Failed to update workspace freezes');
	}
};
