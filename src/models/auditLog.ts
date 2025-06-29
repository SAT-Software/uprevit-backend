import { ObjectId } from 'mongodb';

export enum AuditLogAction {
	CREATE = 'create',
	UPDATE = 'update',
	DELETE = 'delete',
}

export type AuditLog = {
	_id?: ObjectId;
	entity: string;
	entityId: string;
	action: AuditLogAction;
	actionBy: string;
	actionAt: Date;
	active: boolean;
};