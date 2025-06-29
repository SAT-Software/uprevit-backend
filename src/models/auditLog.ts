export enum AuditLogAction {
	CREATE = 'create',
	UPDATE = 'update',
	DELETE = 'delete',
}

export type AuditLog = {
	_id?: string;
	entity: string;
	entityId: string;
	action: AuditLogAction;
	actionBy: string;
	actionAt: Date;
	active: boolean;
};