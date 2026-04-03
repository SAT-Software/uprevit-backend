import { ObjectId } from 'mongodb';

export const AUDIT_LOG_V2_COLLECTION = 'auditLogV2';

export const AUDIT_SCOPE_TYPES = ['product', 'project', 'department', 'source-files', 'archive'] as const;
export type AuditScopeType = typeof AUDIT_SCOPE_TYPES[number];

export const AUDIT_ENTITY_TYPES = ['product', 'project', 'department', 'source_file', 'source_folder'] as const;
export type AuditEntityType = typeof AUDIT_ENTITY_TYPES[number];

export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'move', 'archive', 'restore', 'submit', 'link', 'unlink'] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];

export const AUDIT_VISIBILITY = ['all', 'admin'] as const;
export type AuditVisibility = typeof AUDIT_VISIBILITY[number];

export type AuditLogV2Change = {
	path: string;
	from?: unknown;
	to?: unknown;
};

export type AuditLogV2 = {
	_id?: ObjectId;
	schemaVersion: 2;
	workspaceId: ObjectId;
	scope: {
		type: AuditScopeType;
		id: string;
	};
	entity?: {
		type: AuditEntityType;
		id: string;
	};
	action: AuditAction;
	eventKey: string;
	summary: string;
	actor: {
		userId?: string;
		name: string;
		email?: string;
		role?: 'admin' | 'user';
	};
	where: {
		module: 'products' | 'projects' | 'departments' | 'source-files' | 'archive';
		tab?: string;
		parentId?: string;
	};
	changes?: AuditLogV2Change[];
	visibility: AuditVisibility;
	occurredAt: Date;
	legacy?: {
		source: 'audit_log';
		legacyId?: string;
		isBackfilled?: boolean;
	};
};
