import type { APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
	AUDIT_ACTIONS,
	AUDIT_ENTITY_TYPES,
	AUDIT_SCOPE_TYPES,
	type AuditAction,
	type AuditEntityType,
	type AuditScopeType,
} from '../models/auditLogV2';
import { ResponseWrapper } from './responseWrapper';

export const ADMIN_ONLY_AUDIT_SCOPES: AuditScopeType[] = ['department', 'project', 'archive', 'workspace'];
export const AUDIT_SCOPES_WITHOUT_SCOPE_ID: AuditScopeType[] = ['archive', 'workspace'];
export const MAX_AUDIT_SEARCH_LENGTH = 200;
const MAX_ACTOR_ID_LENGTH = 128;

export const parseAuditGroups = (groups: unknown): string[] => {
	if (Array.isArray(groups)) return groups.filter((group): group is string => typeof group === 'string');
	if (typeof groups === 'string') return groups.split(',').map((group) => group.trim()).filter(Boolean);
	return [];
};

export const isAuditAdmin = (groups: unknown) => parseAuditGroups(groups).includes('admin');

const escapeRegex = (pattern: string): string => pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const parseActions = (rawActions: string | undefined): AuditAction[] | null => {
	if (!rawActions) return null;
	const actions = rawActions.split(',').map((action) => action.trim().toLowerCase()).filter(Boolean);
	if (!actions.length) return null;
	const invalid = actions.find((action) => !AUDIT_ACTIONS.includes(action as AuditAction));
	if (invalid) throw new Error(`Invalid action filter: ${invalid}`);
	return actions as AuditAction[];
};

export type AuditLogQueryResult =
	| { ok: true; query: Record<string, unknown> }
	| { ok: false; response: APIGatewayProxyResult };

/**
 * Validates audit-log query parameters and builds the Mongo filter. One builder for the list and the export so an
 * exported CSV always matches the rows the admin saw.
 *
 * @param {object} input Workspace, raw query parameters and whether the caller is an admin
 * @return {AuditLogQueryResult} The Mongo filter, or the error response to return
 */
export const buildAuditLogQuery = ({
	workspaceId,
	params,
	isAdmin,
}: {
	workspaceId: ObjectId;
	params: Record<string, string | undefined>;
	isAdmin: boolean;
}): AuditLogQueryResult => {
	const scopeTypeRaw = params.scopeType;
	if (!scopeTypeRaw || !AUDIT_SCOPE_TYPES.includes(scopeTypeRaw as AuditScopeType)) {
		return { ok: false, response: ResponseWrapper.badRequest(`scopeType query parameter must be one of: ${AUDIT_SCOPE_TYPES.join(', ')}`) };
	}

	const scopeType = scopeTypeRaw as AuditScopeType;
	if (ADMIN_ONLY_AUDIT_SCOPES.includes(scopeType) && !isAdmin) {
		return { ok: false, response: ResponseWrapper.forbidden('Insufficient permissions to view this log scope.') };
	}

	const scopeId = params.scopeId;
	if (!AUDIT_SCOPES_WITHOUT_SCOPE_ID.includes(scopeType) && !scopeId) {
		return { ok: false, response: ResponseWrapper.badRequest('scopeId query parameter is required for this scope type.') };
	}

	let actionFilters: AuditAction[] | null = null;
	try {
		actionFilters = parseActions(params.actions);
	} catch (error) {
		return { ok: false, response: ResponseWrapper.badRequest(error instanceof Error ? error.message : 'Invalid actions filter.') };
	}

	const search = params.search?.trim();
	if (search && search.length > MAX_AUDIT_SEARCH_LENGTH) {
		return { ok: false, response: ResponseWrapper.badRequest(`search must not exceed ${MAX_AUDIT_SEARCH_LENGTH} characters.`) };
	}

	const entityType = params.entityType;
	if (entityType && !AUDIT_ENTITY_TYPES.includes(entityType as AuditEntityType)) {
		return { ok: false, response: ResponseWrapper.badRequest(`entityType query parameter must be one of: ${AUDIT_ENTITY_TYPES.join(', ')}`) };
	}

	const actorUserId = params.actorUserId?.trim();
	if (actorUserId && actorUserId.length > MAX_ACTOR_ID_LENGTH) {
		return { ok: false, response: ResponseWrapper.badRequest(`actorUserId must not exceed ${MAX_ACTOR_ID_LENGTH} characters.`) };
	}

	const query: Record<string, unknown> = { workspaceId };

	if (!isAdmin) query.visibility = 'all';

	if (scopeType === 'archive') {
		query.action = { $in: ['archive', 'restore'] };
	} else if (scopeType !== 'workspace') {
		query['scope.type'] = scopeType;
		query['scope.id'] = scopeId;
	}

	if (actionFilters?.length) {
		if (scopeType === 'archive') {
			const archiveActions = actionFilters.filter((action) => action === 'archive' || action === 'restore');
			query.action = { $in: archiveActions.length ? archiveActions : ['archive', 'restore'] };
		} else {
			query.action = { $in: actionFilters };
		}
	}

	if (entityType) query['entity.type'] = entityType;
	// `actor.userId` stores the Cognito sub, not the Mongo user id.
	if (actorUserId) query['actor.userId'] = actorUserId;
	if (search) query.summary = { $regex: escapeRegex(search), $options: 'i' };

	if (params.from || params.to) {
		const dateQuery: Record<string, Date> = {};
		if (params.from) {
			const parsedFrom = new Date(params.from);
			if (Number.isNaN(parsedFrom.getTime())) return { ok: false, response: ResponseWrapper.badRequest('from must be a valid date value.') };
			dateQuery.$gte = parsedFrom;
		}
		if (params.to) {
			const parsedTo = new Date(params.to);
			if (Number.isNaN(parsedTo.getTime())) return { ok: false, response: ResponseWrapper.badRequest('to must be a valid date value.') };
			dateQuery.$lte = parsedTo;
		}
		query.occurredAt = dateQuery;
	}

	return { ok: true, query };
};
