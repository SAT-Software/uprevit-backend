import { ObjectId } from 'mongodb';
import { AuditLog } from '../models/auditLog';
import { type AuditAction, type AuditLogV2, AUDIT_LOG_V2_COLLECTION } from '../models/auditLogV2';
import { getDb } from '../utils/db';
import { buildAuditEventSummary } from '../utils/auditEventCatalog';
import { Product } from '../models/product';
import { Project } from '../models/project';
import { Department } from '../models/department';
import { SourceFile } from '../models/sourceFiles';

const toNewAction = (action: AuditLog['action'] | string): AuditAction => {
	const normalized = action.toLowerCase();
	if (normalized === 'unarchive') return 'restore';
	if (normalized === 'create') return 'create';
	if (normalized === 'update') return 'update';
	if (normalized === 'delete') return 'delete';
	if (normalized === 'archive') return 'archive';
	return 'update';
};

const toScope = (entity: string): AuditLogV2['scope']['type'] | null => {
	const normalized = entity.toLowerCase();
	if (normalized === 'project') return 'project';
	if (normalized === 'department') return 'department';
	if (normalized === 'product') return 'product';
	if (normalized === 'sourcefile' || normalized === 'source_file' || normalized === 'source-folder') return 'source-files';
	return null;
};

const toEventKey = (scopeType: AuditLogV2['scope']['type'], action: AuditAction) => {
	if (scopeType === 'source-files') {
		if (action === 'create') return 'source_files.file.uploaded';
		if (action === 'delete') return 'source_files.file.deleted';
		return `source_files.file.${action === 'restore' ? 'uploaded' : 'deleted'}`;
	}

	if (scopeType === 'product' && action === 'submit') return 'product.submitted';
	if (scopeType === 'product' && action === 'restore') return 'product.restored';
	if (scopeType === 'project' && action === 'restore') return 'project.restored';
	if (scopeType === 'department' && action === 'restore') return 'department.restored';

	if (scopeType === 'product') {
		if (action === 'create') return 'product.created';
		if (action === 'archive') return 'product.archived';
		return 'product.updated';
	}

	if (scopeType === 'project') {
		if (action === 'create') return 'project.created';
		if (action === 'archive') return 'project.archived';
		return 'project.updated';
	}

	if (scopeType === 'department') {
		if (action === 'create') return 'department.created';
		if (action === 'archive') return 'department.archived';
		return 'department.updated';
	}

	return `${scopeType}.updated`;
};

const createSummary = (actorName: string, eventKey: string, action: AuditAction) =>
	buildAuditEventSummary({
		eventKey,
		action,
		changes: [],
		meta: { name: 'legacy record' },
		actorName,
	});

const inferVisibility = (scopeType: AuditLogV2['scope']['type']): AuditLogV2['visibility'] =>
	(scopeType === 'department' || scopeType === 'project' || scopeType === 'archive') ? 'admin' : 'all';

const inferModule = (scopeType: AuditLogV2['scope']['type']): AuditLogV2['where']['module'] => {
	if (scopeType === 'source-files') return 'source-files';
	if (scopeType === 'product') return 'products';
	if (scopeType === 'project') return 'projects';
	if (scopeType === 'department') return 'departments';
	return 'archive';
};

/**
 * Backfills legacy `audit_log` entries into `auditLogV2`.
 * @return {Promise<void>} Resolves when backfill processing completes.
 */
async function run() {
	const db = await getDb();
	const legacyCollection = db.collection<AuditLog>('audit_log');
	const targetCollection = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);
	const dryRun = process.argv.includes('--dry-run');

	const records = await legacyCollection.find({}).sort({ actionAt: 1 }).toArray();

	const resolveWorkspaceId = async (record: AuditLog): Promise<string | null> => {
		if (!ObjectId.isValid(record.entityId)) return null;
		const entityId = new ObjectId(record.entityId);
		const entity = record.entity.toLowerCase();

		if (entity === 'product') {
			const product = await db.collection<Product>('products').findOne({ _id: entityId }, { projection: { workspace_id: 1 } });
			return product?.workspace_id?.toString() ?? null;
		}

		if (entity === 'project') {
			const project = await db.collection<Project>('projects').findOne({ _id: entityId }, { projection: { workspace_id: 1 } });
			return project?.workspace_id?.toString() ?? null;
		}

		if (entity === 'department') {
			const department = await db.collection<Department>('departments').findOne({ _id: entityId }, { projection: { workspace_id: 1 } });
			return department?.workspace_id?.toString() ?? null;
		}

		if (entity === 'sourcefile' || entity === 'source_file') {
			const source = await db.collection<SourceFile>('sourceFiles').findOne({ _id: entityId }, { projection: { workspace_id: 1 } });
			return source?.workspace_id?.toString() ?? null;
		}

		return null;
	};

	const operations: Array<{
		updateOne: {
			filter: Record<string, unknown>;
			update: Record<string, unknown>;
			upsert: boolean;
		};
	}> = [];

	for (const record of records) {
		if (!ObjectId.isValid(record.entityId)) continue;

		const scopeType = toScope(record.entity);
		if (!scopeType) continue;

		const workspaceId = await resolveWorkspaceId(record);
		if (!workspaceId) continue;

		const action = toNewAction(record.action);
		const eventKey = toEventKey(scopeType, action);
		const actorName = record.actionBy || 'Unknown User';

		const payload: AuditLogV2 = {
			schemaVersion: 2,
			workspaceId: new ObjectId(workspaceId),
			scope: {
				type: scopeType,
				id: record.entityId,
			},
			action,
			eventKey,
			summary: createSummary(actorName, eventKey, action),
			actor: {
				name: actorName,
				role: 'user',
			},
			where: {
				module: inferModule(scopeType),
			},
			visibility: inferVisibility(scopeType),
			occurredAt: record.actionAt,
			legacy: {
				source: 'audit_log',
				legacyId: record._id?.toString(),
				isBackfilled: true,
			},
		};

		operations.push({
			updateOne: {
				filter: {
					'legacy.source': 'audit_log',
					'legacy.legacyId': record._id?.toString(),
				},
				update: {
					$setOnInsert: payload,
				},
				upsert: true,
			},
		});
	}

	if (dryRun) {
		// eslint-disable-next-line no-console
		console.log(`[dry-run] Prepared ${operations.length} auditLogV2 backfill operations.`);
		return;
	}

	if (!operations.length) {
		// eslint-disable-next-line no-console
		console.log('No legacy audit_log records eligible for backfill.');
		return;
	}

	const result = await targetCollection.bulkWrite(operations, { ordered: false });

	// eslint-disable-next-line no-console
	console.log(
		`Backfill complete. matched=${result.matchedCount}, inserted=${result.upsertedCount}, modified=${result.modifiedCount}`,
	);
}

run().catch((error) => {
	// eslint-disable-next-line no-console
	console.error('Backfill failed', error);
	process.exit(1);
});
