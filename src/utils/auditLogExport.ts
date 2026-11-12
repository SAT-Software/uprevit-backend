import { ObjectId } from 'mongodb';
import { AUDIT_LOG_V2_COLLECTION, type AuditLogExportFilters, type AuditLogV2 } from '../models/auditLogV2';
import { getDb } from './db';
import { buildAuditLogQuery } from './auditLogQuery';

export const AUDIT_EXPORT_MAX_ROWS = 10000;

const csvCell = (value: unknown): string => {
	if (value === null || value === undefined) return '';
	const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Builds the audit log CSV. Auditors open the file in Excel; the BOM keeps non-ASCII names readable there.
 *
 * @param {AuditLogV2[]} logs Audit events, newest first
 * @return {Buffer} UTF-8 CSV with a BOM
 */
export const buildAuditLogCsv = (logs: AuditLogV2[]): Buffer => {
	const header = ['occurredAt', 'action', 'eventKey', 'summary', 'actorName', 'actorEmail', 'actorRole', 'actorUserId', 'scopeType', 'scopeId', 'entityType', 'entityId', 'module', 'tab', 'changes'];
	const rows = logs.map((log) => [
		log.occurredAt.toISOString(),
		log.action,
		log.eventKey,
		log.summary,
		log.actor.name,
		log.actor.email,
		log.actor.role,
		log.actor.userId,
		log.scope.type,
		log.scope.id,
		log.entity?.type,
		log.entity?.id,
		log.where.module,
		log.where.tab,
		log.changes ?? [],
	].map(csvCell).join(','));
	return Buffer.from(`\uFEFF${[header.join(','), ...rows].join('\r\n')}`, 'utf8');
};

/**
 * Loads the newest matching workspace events, capped at AUDIT_EXPORT_MAX_ROWS.
 *
 * @param {object} input Workspace and stored export filters
 * @return {Promise<object>} The rows, the full match count and whether the rows were capped
 */
export const loadAuditLogExportRows = async ({ workspaceId, filters }: { workspaceId: ObjectId; filters: AuditLogExportFilters }) => {
	const built = buildAuditLogQuery({
		workspaceId,
		isAdmin: true,
		params: {
			scopeType: 'workspace',
			search: filters.search,
			actions: filters.actions?.join(','),
			entityType: filters.entityType,
			actorUserId: filters.actorUserId,
			from: filters.from,
			to: filters.to,
		},
	});
	if (!built.ok) throw new Error('Stored audit log export filters are no longer valid');

	const db = await getDb();
	const collection = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);
	const [logs, totalCount] = await Promise.all([
		collection.find(built.query).sort({ occurredAt: -1, _id: -1 }).limit(AUDIT_EXPORT_MAX_ROWS).toArray(),
		collection.countDocuments(built.query),
	]);

	return { logs, totalCount, truncated: totalCount > logs.length };
};
