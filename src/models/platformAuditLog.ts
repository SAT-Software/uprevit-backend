import { ObjectId } from 'mongodb';

export const PLATFORM_AUDIT_LOGS_COLLECTION = 'platformAuditLogs';

/** Excluded from operator-facing audit lists (noisy; not written after Phase 1 fix pass). */
export const PLATFORM_AUDIT_SESSION_ACCESS_ACTION = 'platform_operator.session_access' as const;

export const PLATFORM_AUDIT_ACTIONS = [
	PLATFORM_AUDIT_SESSION_ACCESS_ACTION,
	'platform_operator.allowlist_failed',
	'workspace.detail.view',
	'workspace.provision_invite.create',
	'workspace_admin.invite.create',
	'workspace.freeze.update',
	'billing.account.view',
	'billing.account.update',
	'usage.adjustment.create',
	'chargebee.customer.create',
	'chargebee.usage.sync',
] as const;

export type PlatformAuditAction = typeof PLATFORM_AUDIT_ACTIONS[number];

export type PlatformAuditTargetType =
	| 'workspace'
	| 'user'
	| 'billing_account'
	| 'usage_event'
	| 'usage_snapshot'
	| 'chargebee_customer'
	| 'system';

export type PlatformAuditLogStatus = 'success' | 'failed';

export type PlatformAuditMetadataSource =
	| 'platform-admin-portal'
	| 'api'
	| 'job'
	| 'webhook';

export type PlatformAuditLogChange = {
	path: string;
	from?: unknown;
	to?: unknown;
};

export type PlatformAuditLog = {
	_id?: ObjectId;
	schemaVersion: 1;
	actor: {
		platformAdminId?: ObjectId;
		cognitoSub: string;
		email?: string;
		name?: string;
		groups: string[];
		role?: 'owner' | 'operator' | 'viewer';
	};
	action: PlatformAuditAction;
	target: {
		type: PlatformAuditTargetType;
		workspaceId?: ObjectId;
		entityId?: string;
	};
	summary: string;
	changes?: PlatformAuditLogChange[];
	metadata?: {
		requestId?: string;
		ip?: string;
		userAgent?: string;
		source: PlatformAuditMetadataSource;
	};
	status: PlatformAuditLogStatus;
	errorMessage?: string;
	occurredAt: Date;
};
