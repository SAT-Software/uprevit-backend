import { getDb } from './db';
import { AuditLog } from '../models/auditLog';

/**
 * Updates the audit log
 * @param {AuditLog} auditLog - The audit log to update
 * @return {Promise<InsertOneResult<AuditLog>>} The result of the update
 */
export const updateAuditLog = async (auditLog: AuditLog) => {
	const db = await getDb();

	// find existing active record
	const existingAuditLog = await db
	    .collection<AuditLog>('audit_log')
	    .findOne({ entity: auditLog.entity, entityId: auditLog.entityId, action: auditLog.action, active: true });

	// if found, update active to false
	if (existingAuditLog) {
	    await db
	        .collection<AuditLog>('audit_log')
	        .updateOne({ _id: existingAuditLog._id }, { $set: { active: false } });
	}

	// insert new record
	const result = await db.collection<AuditLog>('audit_log').insertOne(auditLog);
	return result;
};
