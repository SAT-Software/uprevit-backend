import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { toExportJobSummary } from '../../utils/exportJobSerializers';
import { listExportJobsForUser } from '../../utils/exportJobs';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { createExportPresignedGetUrl } from '../../utils/s3-storage';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Lists the caller's audit log export jobs, with a download URL on completed ones. Admin only.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Audit log export jobs list response
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Insufficient permissions');

		const { jobs, pagination, hasActiveJobs, activeJobsCount } = await listExportJobsForUser({
			requestedBySub: context.cognitoSub,
			workspaceId: context.workspaceId,
			target: 'audit_log',
			page: 1,
		});

		const now = Date.now();
		const result = await Promise.all(jobs.map(async (job) => {
			const summary = toExportJobSummary(job);
			if (job.status !== 'completed' || !job.s3Key || job.expiresAt.getTime() <= now) return summary;
			const secondsUntilExpiry = Math.floor((job.expiresAt.getTime() - now) / 1000);
			const downloadUrl = await createExportPresignedGetUrl(job.s3Key, job.fileName, secondsUntilExpiry);
			return { ...summary, downloadUrl };
		}));

		return ResponseWrapper.success({
			message: 'Audit log export jobs fetched successfully',
			result: { jobs: result, hasActiveJobs, activeJobsCount, pagination },
		});
	} catch (error) {
		logError('Get audit log export jobs handler failed', error);
		return ResponseWrapper.internalServerError('Failed to fetch audit log export jobs');
	}
});
