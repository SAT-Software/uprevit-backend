import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AuditAction, AuditEntityType, AuditLogExportFilters } from '../../models/auditLogV2';
import { EXPORT_JOB_COLLECTION } from '../../models/exportJob';
import { buildAuditLogQuery } from '../../utils/auditLogQuery';
import { assertUsageActionAllowed } from '../../utils/billing/enforcement';
import { getDb } from '../../utils/db';
import { createQueuedExportJob } from '../../utils/exportJobs';
import { enqueueExportJobMessage } from '../../utils/exportQueue';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

const toFilters = (body: Record<string, unknown>): AuditLogExportFilters => ({
	...(typeof body.search === 'string' && { search: body.search }),
	...(Array.isArray(body.actions) && { actions: body.actions.filter((action): action is AuditAction => typeof action === 'string') }),
	...(typeof body.entityType === 'string' && { entityType: body.entityType as AuditEntityType }),
	...(typeof body.actorUserId === 'string' && { actorUserId: body.actorUserId }),
	...(typeof body.from === 'string' && { from: body.from }),
	...(typeof body.to === 'string' && { to: body.to }),
});

/**
 * Queues a CSV export of the workspace audit trail for the current filters. Admin only.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Accepted response with job id
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Insufficient permissions');

		const body: unknown = event.body ? JSON.parse(event.body) : {};
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return ResponseWrapper.badRequest('Request body must be a JSON object');
		}

		const auditLogFilters = toFilters(body as Record<string, unknown>);
		const built = buildAuditLogQuery({
			workspaceId: context.workspaceId,
			isAdmin: true,
			params: {
				scopeType: 'workspace',
				search: auditLogFilters.search,
				actions: auditLogFilters.actions?.join(','),
				entityType: auditLogFilters.entityType,
				actorUserId: auditLogFilters.actorUserId,
				from: auditLogFilters.from,
				to: auditLogFilters.to,
			},
		});
		if (!built.ok) return built.response;

		const exportCheck = await assertUsageActionAllowed(context.workspaceId, 'export', 1);
		if (!exportCheck.allowed) return ResponseWrapper.forbidden(exportCheck.reason);

		const job = await createQueuedExportJob({
			target: 'audit_log',
			workspaceId: context.workspaceId,
			requestedBySub: context.cognitoSub,
			requestedByUserId: context.userId,
			format: 'csv',
			auditLogFilters,
		});

		try {
			await enqueueExportJobMessage({
				schemaVersion: 1,
				jobId: job._id.toString(),
				target: 'audit_log',
				workspaceId: context.workspaceId.toString(),
				requestedBySub: context.cognitoSub,
				requestedByUserId: context.userId.toString(),
				format: 'csv',
				queuedAt: job.createdAt.toISOString(),
			});
		} catch (queueError) {
			const db = await getDb();
			await db.collection(EXPORT_JOB_COLLECTION).deleteOne({ _id: job._id });
			throw queueError;
		}

		return ResponseWrapper.accepted({
			message: 'Audit log export queued successfully',
			result: { jobId: job._id.toString(), status: job.status },
		});
	} catch (error) {
		if (error instanceof SyntaxError) return ResponseWrapper.badRequest('Request body contains invalid JSON');
		logError('Failed to queue audit log export', error);
		return ResponseWrapper.internalServerError('Failed to queue audit log export');
	}
});
