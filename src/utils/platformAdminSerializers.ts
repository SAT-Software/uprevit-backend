import { ObjectId } from 'mongodb';
import type { PlatformAdmin } from '../models/platformAdmin';
import type { PlatformAuditLog } from '../models/platformAuditLog';
import type { Workspace } from '../models/workspace';
import type { User } from '../models/user';

export type WorkspaceBillingPreview = {
	status: 'not_set';
	meteringEnabled: null;
	billingCadence: null;
	currency: null;
	pastDue: null;
};

export const emptyBillingPreview = (): WorkspaceBillingPreview => ({
	status: 'not_set',
	meteringEnabled: null,
	billingCadence: null,
	currency: null,
	pastDue: null,
});

export const serializePlatformOperator = (operator: PlatformAdmin) => ({
	id: operator._id?.toString(),
	email: operator.email,
	name: operator.name ?? null,
	role: operator.role,
	status: operator.status,
	lastSeenAt: operator.lastSeenAt?.toISOString() ?? null,
});

export const serializeWorkspaceListItem = (
	workspace: Workspace & { _id: ObjectId; memberCount?: number },
) => ({
	id: workspace._id.toString(),
	workspaceName: workspace.workspaceName,
	companyName: workspace.companyName,
	logo: workspace.logo || null,
	planName: workspace.planName || null,
	memberCount: workspace.memberCount ?? workspace.userIds?.length ?? 0,
	billing: emptyBillingPreview(),
});

export const serializeWorkspaceAdmin = (user: User & { _id: ObjectId }) => ({
	id: user._id.toString(),
	name: user.name,
	email: user.email,
	status: user.status,
	userType: user.userType,
});

export const serializePlatformAuditLog = (log: PlatformAuditLog & { _id?: ObjectId }) => ({
	id: log._id?.toString(),
	action: log.action,
	summary: log.summary,
	status: log.status,
	actor: {
		email: log.actor.email ?? null,
		name: log.actor.name ?? null,
		role: log.actor.role ?? null,
	},
	target: {
		type: log.target.type,
		workspaceId: log.target.workspaceId?.toString() ?? null,
		entityId: log.target.entityId ?? null,
	},
	occurredAt: log.occurredAt.toISOString(),
	errorMessage: log.errorMessage ?? null,
});
