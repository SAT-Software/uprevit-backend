import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { AUDIT_LOG_V2_COLLECTION, type AuditLogV2 } from '../../models/auditLogV2';
import { buildAuditLogQuery, isAuditAdmin } from '../../utils/auditLogQuery';
import { getDb } from '../../utils/db';
import { enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';
import { logError, logInfo } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Fetches paginated auditLogV2 records for a workspace scope.
 *
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Paginated audit log response
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		const requestedWorkspaceId = event.queryStringParameters?.workspaceId;
		const scopeType = event.queryStringParameters?.scopeType;
		const scopeId = event.queryStringParameters?.scopeId;
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

		if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('limit must be a number between 1 and 100.');
		}

		if (!Number.isFinite(page) || page < 1) {
			return ResponseWrapper.badRequest('page must be a number greater than or equal to 1.');
		}

		const built = buildAuditLogQuery({
			workspaceId: context.workspaceId,
			params: event.queryStringParameters ?? {},
			isAdmin: isAuditAdmin(auth.payload['cognito:groups']),
		});
		if (!built.ok) return built.response;
		const { query } = built;

		const db = await getDb();
		const collection = db.collection<AuditLogV2>(AUDIT_LOG_V2_COLLECTION);

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

		const signingOptions = {
			workspaceId: context.workspaceId,
			pendingOwnerId: context.cognitoSub,
		};
		const signedActors = await enrichUsersWithProfileAvatarUrls(
			logs.map((log) => log.actor),
			signingOptions,
		);
		const logsWithSignedAvatars = logs.map((log, index) => ({
			...log,
			actor: signedActors[index] ?? log.actor,
		}));

		logInfo('✅ auditLogs/getAuditLogs result', {
			page,
			limit,
			totalCount,
			returnedCount: logsWithSignedAvatars.length,
			firstLogId: logsWithSignedAvatars[0]?._id?.toString(),
			lastLogId: logsWithSignedAvatars.length ? logsWithSignedAvatars[logsWithSignedAvatars.length - 1]?._id?.toString() : undefined,
			requestId: event.requestContext?.requestId,
		});

		return ResponseWrapper.success({
			message: 'Audit logs fetched successfully',
			result: {
				logs: logsWithSignedAvatars,
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
});
