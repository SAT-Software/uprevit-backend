/* eslint-disable no-unused-vars */
import { ObjectId } from 'mongodb';

/**
 * Audit log actions
 */
export enum AuditLogAction {
	CREATE = 'create',
	UPDATE = 'update',
	DELETE = 'delete',
	ARCHIVE = 'archive',
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
