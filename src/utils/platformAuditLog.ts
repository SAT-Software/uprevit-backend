import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import { type Db, ObjectId } from 'mongodb';
import {
	PLATFORM_AUDIT_LOGS_COLLECTION,
	type PlatformAuditAction,
	type PlatformAuditLog,
	type PlatformAuditLogChange,
	type PlatformAuditLogStatus,
	type PlatformAuditMetadataSource,
	type PlatformAuditTargetType,
} from '../models/platformAuditLog';
import type { PlatformAdmin, PlatformAdminRole } from '../models/platformAdmin';
import { getDb } from './db';
import { logError } from './logger';

let hasEnsuredPlatformAuditLogIndexes = false;

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

const resolveActorEmail = (
	auth: Partial<CognitoAccessTokenPayload>,
	operator?: PlatformAdmin,
): string | undefined => {
	if (operator?.email) return operator.email;
	const emailClaim = getClaimString(auth, ['email']);
	if (emailClaim) return emailClaim;
	const usernameClaim = getClaimString(auth, ['username', 'cognito:username']);
	if (usernameClaim?.includes('@')) return usernameClaim;
	return undefined;
};

export const ensurePlatformAuditLogIndexes = async (db: Db): Promise<void> => {
	if (hasEnsuredPlatformAuditLogIndexes) return;

	const collection = db.collection(PLATFORM_AUDIT_LOGS_COLLECTION);
	await Promise.all([
		collection.createIndex({ occurredAt: -1 }),
		collection.createIndex({ 'actor.cognitoSub': 1, occurredAt: -1 }),
		collection.createIndex({ 'target.workspaceId': 1, occurredAt: -1 }),
		collection.createIndex({ action: 1, occurredAt: -1 }),
		collection.createIndex({ status: 1, occurredAt: -1 }),
	]);

	hasEnsuredPlatformAuditLogIndexes = true;
};

export const ensurePlatformAdminIndexes = async (db: Db): Promise<void> => {
	const collection = db.collection('platformAdmins');
	await Promise.all([
		collection.createIndex({ cognitoSub: 1 }, { unique: true }),
		collection.createIndex({ email: 1 }, { unique: true }),
		collection.createIndex({ status: 1 }),
	]);
};

export type RecordPlatformAuditEventInput = {
	action: PlatformAuditAction;
	targetType: PlatformAuditTargetType;
	workspaceId?: string | ObjectId;
	entityId?: string;
	summary: string;
	auth: Partial<CognitoAccessTokenPayload>;
	operator?: PlatformAdmin;
	status?: PlatformAuditLogStatus;
	errorMessage?: string;
	changes?: PlatformAuditLogChange[];
	event?: APIGatewayProxyEvent;
	source?: PlatformAuditMetadataSource;
};

/**
 * Appends a platform audit log entry.
 */
export const recordPlatformAuditEvent = async (input: RecordPlatformAuditEventInput): Promise<void> => {
	try {
		const db = await getDb();
		await ensurePlatformAuditLogIndexes(db);

		const groups = parseGroups(input.auth['cognito:groups']);
		const cognitoSub = getClaimString(input.auth, ['sub']) ?? 'unknown';
		const workspaceObjectId = input.workspaceId
			? (input.workspaceId instanceof ObjectId ? input.workspaceId : new ObjectId(input.workspaceId))
			: undefined;

		const doc: PlatformAuditLog = {
			schemaVersion: 1,
			actor: {
				platformAdminId: input.operator?._id,
				cognitoSub,
				email: resolveActorEmail(input.auth, input.operator),
				name: input.operator?.name ?? getClaimString(input.auth, ['name']),
				groups,
				role: input.operator?.role,
			},
			action: input.action,
			target: {
				type: input.targetType,
				workspaceId: workspaceObjectId,
				entityId: input.entityId,
			},
			summary: input.summary,
			changes: input.changes,
			metadata: {
				requestId: input.event?.requestContext?.requestId,
				ip: input.event?.requestContext?.identity?.sourceIp,
				userAgent: input.event?.headers?.['User-Agent'] ?? input.event?.headers?.['user-agent'],
				source: input.source ?? 'api',
			},
			status: input.status ?? 'success',
			errorMessage: input.errorMessage,
			occurredAt: new Date(),
		};

		await db.collection<PlatformAuditLog>(PLATFORM_AUDIT_LOGS_COLLECTION).insertOne(doc);
	} catch (error) {
		logError('Failed to record platform audit event', error);
	}
};

export const parseCognitoGroups = parseGroups;

export const resolvePlatformActorRole = (role?: PlatformAdminRole): PlatformAdminRole | undefined => role;
