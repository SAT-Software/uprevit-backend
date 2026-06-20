import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import {
	PLATFORM_AUDIT_LOGS_COLLECTION,
	PLATFORM_AUDIT_SESSION_ACCESS_ACTION,
	type PlatformAuditLog,
} from '../../models/platformAuditLog';
import { Workspace } from '../../models/workspace';
import { User } from '../../models/user';
import {
	serializePlatformAuditLog,
	serializeWorkspaceAdmin,
} from '../../utils/platformAdminSerializers';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { resolveLiveWorkspaceBillingPreview } from '../../utils/billing/chargebeeBillingDetail';
import { serializeWorkspaceFreezes } from '../../utils/billing/serializers';

/**
 * Returns workspace profile, admin list, billing preview, and recent platform audit events.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Workspace detail payload
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

		const [admins, memberCount, activeCount, invitedCount, recentAuditLogs, billingAccount] = await Promise.all([
			db.collection<User>('users').find({
				workspaceId: workspaceObjectId,
				userType: 'admin',
			}).sort({ name: 1 }).toArray(),
			db.collection('users').countDocuments({ workspaceId: workspaceObjectId }),
			db.collection('users').countDocuments({ workspaceId: workspaceObjectId, status: 'active' }),
			db.collection('users').countDocuments({ workspaceId: workspaceObjectId, status: 'invited' }),
			db.collection<PlatformAuditLog>(PLATFORM_AUDIT_LOGS_COLLECTION)
				.find({
					'target.workspaceId': workspaceObjectId,
					action: { $ne: PLATFORM_AUDIT_SESSION_ACCESS_ACTION },
				})
				.sort({ occurredAt: -1 })
				.limit(20)
				.toArray(),
			getBillingAccountByWorkspaceId(workspaceObjectId),
		]);

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'workspace.detail.view',
			targetType: 'workspace',
			workspaceId: workspaceObjectId,
			summary: `Viewed workspace ${workspace.workspaceName}`,
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Workspace detail retrieved',
			data: {
				workspace: {
					id: workspaceObjectId.toString(),
					workspaceName: workspace.workspaceName,
					companyName: workspace.companyName,
					description: workspace.description || '',
					logo: workspace.logo || null,
					planName: workspace.planName || null,
				},
				counts: {
					members: memberCount,
					activeMembers: activeCount,
					invitedMembers: invitedCount,
					admins: admins.length,
				},
				admins: admins.map((admin) => serializeWorkspaceAdmin(admin as User & { _id: ObjectId })),
				billing: await resolveLiveWorkspaceBillingPreview(billingAccount),
				freezes: serializeWorkspaceFreezes(workspace),
				recentAuditLogs: recentAuditLogs.map(serializePlatformAuditLog),
			},
		});
	} catch (error) {
		logError('Platform admin get workspace detail failed', error);
		return ResponseWrapper.internalServerError('Failed to load workspace detail');
	}
};
