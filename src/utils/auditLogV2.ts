import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import { type Db, ObjectId } from 'mongodb';
import {
	AUDIT_LOG_V2_COLLECTION,
	type AuditAction,
	type AuditEntityType,
	type AuditLogV2,
	type AuditLogV2Change,
	type AuditScopeType,
	type AuditVisibility,
} from '../models/auditLogV2';
import type { User } from '../models/user';
import { getDb } from './db';
import { buildAuditEventSummary } from './auditEventCatalog';

let hasEnsuredAuditLogV2Indexes = false;
const actorEmailCache = new Map<string, string | null>();

type AuditWhere = {
	module: 'products' | 'projects' | 'departments' | 'source-files' | 'archive';
	tab?: string;
	parentId?: string;
};

export type RecordAuditEventInput = {
	workspaceId: string;
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
	visibility: AuditVisibility;
	where: AuditWhere;
	auth: Partial<CognitoAccessTokenPayload>;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	changedPaths?: string[];
	changes?: AuditLogV2Change[];
	meta?: Record<string, unknown>;
	occurredAt?: Date;
};

const parseGroups = (groups: unknown): string[] => {
	if (Array.isArray(groups)) return groups.filter((group): group is string => typeof group === 'string');
	if (typeof groups === 'string') return groups.split(',').map((group) => group.trim()).filter(Boolean);
	return [];
};

const getClaimString = (claims: Partial<CognitoAccessTokenPayload>, keys: string[]): string | undefined => {
	const rawClaims = claims as Record<string, unknown>;
	for (const key of keys) {
		const value = rawClaims[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}

	return undefined;
};

const isLikelyEmail = (value: string) => /^\S+@\S+\.\S+$/.test(value);

const resolveActorEmail = async ({
	db,
	workspaceId,
	auth,
}: {
	db: Db;
	workspaceId: string;
	auth: Partial<CognitoAccessTokenPayload>;
}): Promise<string | undefined> => {
	const emailClaim = getClaimString(auth, ['email']);
	if (emailClaim) return emailClaim;

	const usernameClaim = getClaimString(auth, ['username', 'cognito:username']);
	if (usernameClaim && isLikelyEmail(usernameClaim)) return usernameClaim;

	const sub = getClaimString(auth, ['sub']);
	if (!sub || !ObjectId.isValid(workspaceId)) return undefined;

	const cacheKey = `${workspaceId}:${sub}`;
	if (actorEmailCache.has(cacheKey)) {
		return actorEmailCache.get(cacheKey) ?? undefined;
	}

	try {
		const user = await db.collection<User>('users').findOne(
			{
				cognitoSub: sub,
				workspaceId: new ObjectId(workspaceId),
			},
			{
				projection: { email: 1 },
			},
		);

		const resolvedEmail = typeof user?.email === 'string' && user.email.trim() ? user.email.trim() : undefined;
		actorEmailCache.set(cacheKey, resolvedEmail ?? null);
		return resolvedEmail;
	} catch {
		return undefined;
	}
};

const normalizeValue = (value: unknown): unknown => {
	if (value instanceof ObjectId) return value.toString();
	if (value instanceof Date) return value.toISOString();

	if (Array.isArray(value)) return value.map((item) => normalizeValue(item));

	if (value && typeof value === 'object') {
		const normalizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, normalizeValue(entryValue)]);
		return Object.fromEntries(normalizedEntries);
	}

	return value;
};

const getValueByPath = (source: Record<string, unknown> | null | undefined, path: string): unknown => {
	if (!source) return undefined;

	const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
	let current: unknown = source;

	for (const token of tokens) {
		if (current == null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[token];
	}

	return normalizeValue(current);
};

const valuesDiffer = (first: unknown, second: unknown) => JSON.stringify(first) !== JSON.stringify(second);

export const buildChangesFromPaths = ({
	before,
	after,
	paths,
}: {
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	paths?: string[];
}): AuditLogV2Change[] => {
	if (!before && !after) return [];

	const candidatePaths = paths && paths.length
		? paths
		: Array.from(new Set([
			...Object.keys((before ?? {}) as Record<string, unknown>),
			...Object.keys((after ?? {}) as Record<string, unknown>),
		]));

	const changes: AuditLogV2Change[] = [];

	for (const path of candidatePaths) {
		const from = getValueByPath(before ?? undefined, path);
		const to = getValueByPath(after ?? undefined, path);

		if (!valuesDiffer(from, to)) continue;

		changes.push({ path, from, to });
	}

	return changes;
};

const ensureAuditLogV2Indexes = async () => {
	if (hasEnsuredAuditLogV2Indexes) return;

	const db = await getDb();
	const collection = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);

	await Promise.all([
		collection.createIndex({ workspaceId: 1, 'scope.type': 1, 'scope.id': 1, occurredAt: -1 }),
		collection.createIndex({ workspaceId: 1, action: 1, occurredAt: -1 }),
		collection.createIndex({ workspaceId: 1, visibility: 1, occurredAt: -1 }),
		collection.createIndex({ 'entity.type': 1, 'entity.id': 1, occurredAt: -1 }),
		collection.createIndex({ 'legacy.source': 1, 'legacy.legacyId': 1 }, { unique: true, sparse: true }),
	]);

	hasEnsuredAuditLogV2Indexes = true;
};

export const recordAuditEvent = async (input: RecordAuditEventInput) => {
	await ensureAuditLogV2Indexes();

	const db = await getDb();
	const collection = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);

	const groups = parseGroups(input.auth['cognito:groups']);
	const actorRole: 'admin' | 'user' = groups.includes('admin') ? 'admin' : 'user';
	const usernameClaim = getClaimString(input.auth, ['username', 'cognito:username']);
	const actorEmail = await resolveActorEmail({
		db,
		workspaceId: input.workspaceId,
		auth: input.auth,
	});
	const actorName = getClaimString(input.auth, ['name']) ?? actorEmail ?? usernameClaim ?? 'Unknown User';

	const computedChanges = input.changes ?? buildChangesFromPaths({
		before: input.before,
		after: input.after,
		paths: input.changedPaths,
	});

	const summary = buildAuditEventSummary({
		eventKey: input.eventKey,
		action: input.action,
		changes: computedChanges,
		meta: input.meta,
		actorName,
	});

	const payload: AuditLogV2 = {
		schemaVersion: 2,
		workspaceId: new ObjectId(input.workspaceId),
		scope: input.scope,
		entity: input.entity,
		action: input.action,
		eventKey: input.eventKey,
		summary,
		actor: {
			userId: input.auth.sub,
			name: actorName,
			email: actorEmail,
			role: actorRole,
		},
		where: input.where,
		changes: computedChanges,
		visibility: input.visibility,
		occurredAt: input.occurredAt ?? new Date(),
	};

	await collection.insertOne(payload);
};
