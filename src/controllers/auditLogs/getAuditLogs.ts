import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
	AUDIT_ACTIONS,
	AUDIT_LOG_V2_COLLECTION,
	AUDIT_SCOPE_TYPES,
	type AuditAction,
	type AuditLogV2,
	type AuditScopeType,
} from '../../models/auditLogV2';
import { getDb } from '../../utils/db';
import { logError, logInfo } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';

const ADMIN_ONLY_SCOPES: AuditScopeType[] = ['department', 'project', 'archive'];
const MAX_SEARCH_LENGTH = 200;

const parseGroups = (groups: unknown): string[] => {
	if (Array.isArray(groups)) return groups.filter((group): group is string => typeof group === 'string');
	if (typeof groups === 'string') return groups.split(',').map((group) => group.trim()).filter(Boolean);
	return [];
};

const isAdminUser = (groups: unknown) => parseGroups(groups).includes('admin');

const escapeRegex = (pattern: string): string => pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const parseActions = (rawActions: string | undefined): AuditAction[] | null => {
	if (!rawActions) return null;

	const actions = rawActions
		.split(',')
		.map((action) => action.trim().toLowerCase())
		.filter(Boolean);

	if (!actions.length) return null;

	const invalidAction = actions.find((action) => !AUDIT_ACTIONS.includes(action as AuditAction));
	if (invalidAction) throw new Error(`Invalid action filter: ${invalidAction}`);

	return actions as AuditAction[];
};

/**
 * Fetches paginated auditLogV2 records for a workspace scope.
 *
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Paginated audit log response
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		const requestedWorkspaceId = event.queryStringParameters?.workspaceId;
		const scopeTypeRaw = event.queryStringParameters?.scopeType;
		const scopeId = event.queryStringParameters?.scopeId;
		const search = event.queryStringParameters?.search?.trim();
		const fromDate = event.queryStringParameters?.from;
		const toDate = event.queryStringParameters?.to;
		const page = Number.parseInt(event.queryStringParameters?.page ?? '1', 10);
		const limit = Number.parseInt(event.queryStringParameters?.limit ?? '20', 10);

		logInfo('🔎 auditLogs/getAuditLogs request params', {
			queryStringParameters: event.queryStringParameters ?? {},
			parsedPage: page,
			parsedLimit: limit,
			requestId: event.requestContext?.requestId,
		});

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('workspaceId query parameter must be a valid ObjectId.');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		if (!scopeTypeRaw || !AUDIT_SCOPE_TYPES.includes(scopeTypeRaw as AuditScopeType)) {
			return ResponseWrapper.badRequest(`scopeType query parameter must be one of: ${AUDIT_SCOPE_TYPES.join(', ')}`);
		}

		const scopeType = scopeTypeRaw as AuditScopeType;

		if (scopeType !== 'archive' && !scopeId) {
			return ResponseWrapper.badRequest('scopeId query parameter is required for this scope type.');
		}

		if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('limit must be a number between 1 and 100.');
		}

		if (!Number.isFinite(page) || page < 1) {
			return ResponseWrapper.badRequest('page must be a number greater than or equal to 1.');
		}

		const adminUser = isAdminUser(auth.payload['cognito:groups']);
		if (ADMIN_ONLY_SCOPES.includes(scopeType) && !adminUser) {
			return ResponseWrapper.forbidden('Insufficient permissions to view this log scope.');
		}

		let actionFilters: AuditAction[] | null = null;
		try {
			actionFilters = parseActions(event.queryStringParameters?.actions);
		} catch (error) {
			return ResponseWrapper.badRequest(error instanceof Error ? error.message : 'Invalid actions filter.');
		}
		const db = await getDb();
		const collection = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);

		const query: Record<string, unknown> = {
			workspaceId: context.workspaceId,
		};

		if (!adminUser) {
			query.visibility = 'all';
		}

		if (scopeType === 'archive') {
			query.action = { $in: ['archive', 'restore'] };
		} else {
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

		if (search && search.length > MAX_SEARCH_LENGTH) {
			return ResponseWrapper.badRequest(`search must not exceed ${MAX_SEARCH_LENGTH} characters.`);
		}

		if (search) {
			query.summary = { $regex: escapeRegex(search), $options: 'i' };
		}

		if (fromDate || toDate) {
			const dateQuery: Record<string, Date> = {};
			if (fromDate) {
				const parsedFrom = new Date(fromDate);
				if (Number.isNaN(parsedFrom.getTime())) return ResponseWrapper.badRequest('from must be a valid date value.');
				dateQuery.$gte = parsedFrom;
			}

			if (toDate) {
				const parsedTo = new Date(toDate);
				if (Number.isNaN(parsedTo.getTime())) return ResponseWrapper.badRequest('to must be a valid date value.');
				dateQuery.$lte = parsedTo;
			}

			query.occurredAt = dateQuery;
		}

		const skip = (page - 1) * limit;

		logInfo('📄 auditLogs/getAuditLogs pagination', {
			page,
			limit,
			skip,
			scopeType,
			scopeId,
			requestId: event.requestContext?.requestId,
		});

		const [logs, totalCount] = await Promise.all([
			collection
				.find(query)
				.sort({ occurredAt: -1, _id: -1 })
				.skip(skip)
				.limit(limit)
				.toArray(),
			collection.countDocuments(query),
		]);

		logInfo('✅ auditLogs/getAuditLogs result', {
			page,
			limit,
			totalCount,
			returnedCount: logs.length,
			firstLogId: logs[0]?._id?.toString(),
			lastLogId: logs.length ? logs[logs.length - 1]?._id?.toString() : undefined,
			requestId: event.requestContext?.requestId,
		});

		return ResponseWrapper.success({
			message: 'Audit logs fetched successfully',
			result: {
				logs,
				pagination: {
					page,
					limit,
					totalCount,
					totalPages: Math.max(1, Math.ceil(totalCount / limit)),
					hasNextPage: page * limit < totalCount,
					hasPrevPage: page > 1,
				},
			},
		});
	} catch (error) {
		logError('Get audit logs handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get audit logs in auditLogs/getAuditLogs handler.');
	}
};
