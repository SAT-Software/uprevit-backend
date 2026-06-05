import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import {
	PLATFORM_ADMINS_COLLECTION,
	type PlatformAdmin,
} from '../models/platformAdmin';
import { User } from '../models/user';
import { authenticateRequest, type AuthResult } from './authUtils';
import { getDb } from './db';
import { ResponseWrapper } from './responseWrapper';
import {
	ensurePlatformAdminIndexes,
	parseCognitoGroups,
	recordPlatformAuditEvent,
} from './platformAuditLog';

const PLATFORM_ADMIN_COGNITO_GROUP = 'platform-admin';

export type PlatformOperatorContext = {
	auth: Extract<AuthResult, { isValid: true }>;
	operator: PlatformAdmin;
};

export type PlatformOperatorResult =
	| { ok: true; context: PlatformOperatorContext }
	| { ok: false; response: APIGatewayProxyResult };

const hasPlatformAdminGroup = (payload: CognitoAccessTokenPayload): boolean =>
	parseCognitoGroups(payload['cognito:groups']).includes(PLATFORM_ADMIN_COGNITO_GROUP);

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Validates Cognito platform-admin group, active platformAdmins registry row,
 * and an active workspace users row (dual-hat operators only in Phase 1).
 * Does not use tenant workspace context.
 */
export const requirePlatformOperator = async (
	event: APIGatewayProxyEvent,
): Promise<PlatformOperatorResult> => {
	const authResult = await authenticateRequest(event);
	if (!authResult.isValid) {
		return { ok: false, response: authResult.error };
	}

	const auth = authResult;
	const payload = auth.payload;

	if (!hasPlatformAdminGroup(payload)) {
		return {
			ok: false,
			response: ResponseWrapper.forbidden('Insufficient permissions'),
		};
	}

	const db = await getDb();
	await ensurePlatformAdminIndexes(db);

	const operator = await db.collection<PlatformAdmin>(PLATFORM_ADMINS_COLLECTION).findOne({
		cognitoSub: payload.sub,
	});

	if (!operator || operator.status !== 'active') {
		await recordPlatformAuditEvent({
			action: 'platform_operator.allowlist_failed',
			targetType: 'system',
			summary: operator?.status === 'disabled'
				? 'Platform operator registry entry is disabled'
				: 'Platform operator is not in the allowlist registry',
			auth: payload,
			operator: operator ?? undefined,
			status: 'failed',
			errorMessage: 'Platform operator allowlist check failed',
			event,
			source: 'api',
		});

		return {
			ok: false,
			response: ResponseWrapper.forbidden('Platform operator access is not enabled for this account'),
		};
	}

	const operatorEmail = operator.email || (typeof payload.email === 'string' ? payload.email : '');
	const workspaceUser = await db.collection<User>('users').findOne({
		status: 'active',
		$or: [
			{ cognitoSub: payload.sub },
			...(operatorEmail ? [{ email: normalizeEmail(operatorEmail) }] : []),
		],
	});

	if (!workspaceUser) {
		await recordPlatformAuditEvent({
			action: 'platform_operator.allowlist_failed',
			targetType: 'system',
			summary: 'Platform operator does not have an active workspace membership (dual-hat required)',
			auth: payload,
			operator,
			status: 'failed',
			errorMessage: 'Dual-hat platform operator check failed',
			event,
			source: 'api',
		});

		return {
			ok: false,
			response: ResponseWrapper.forbidden(
				'Platform operator access requires an active workspace account in Phase 1',
			),
		};
	}

	await db.collection<PlatformAdmin>(PLATFORM_ADMINS_COLLECTION).updateOne(
		{ _id: operator._id },
		{ $set: { lastSeenAt: new Date(), updatedAt: new Date() } },
	);

	return {
		ok: true,
		context: {
			auth,
			operator: {
				...operator,
				lastSeenAt: new Date(),
			},
		},
	};
};

export const isPlatformAdminCognitoGroup = hasPlatformAdminGroup;
