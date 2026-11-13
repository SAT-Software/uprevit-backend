import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import type { ExportJobDocument, ExportJobStatus, ExportJobTarget } from '../models/exportJob';
import { toExportJobSummary } from './exportJobSerializers';
import { getExportJobByIdForUser, isExportStatus, listExportJobsForUser } from './exportJobs';
import { logError } from './logger';
import { ResponseWrapper } from './responseWrapper';
import { createExportPresignedGetUrl } from './s3-storage';
import { requireTenantContext, type TenantContext } from './tenantContext';
import { withTelemetry } from './telemetry';
import { validateAllObjectIds } from './validationUtils';

type ExportJobResource = {
	label: string;
	target: ExportJobTarget | ExportJobTarget[];
};

type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

type TenantHandler = (event: APIGatewayProxyEvent, context: TenantContext) => Promise<APIGatewayProxyResult>;

const withExportJobContext = (failureLog: string, failureMessage: string, handler: TenantHandler): Handler =>
	withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
		try {
			const tenantResult = await requireTenantContext(event);
			if (!tenantResult.ok) return tenantResult.response;
			return await handler(event, tenantResult.context);
		} catch (error) {
			logError(failureLog, error);
			return ResponseWrapper.internalServerError(failureMessage);
		}
	});

const parseStatusFilters = (statusQuery?: string): ExportJobStatus[] | undefined | null => {
	const statuses = (statusQuery ?? '')
		.split(',')
		.map((status) => status.trim())
		.filter(Boolean);

	if (!statuses.length) return undefined;
	return statuses.every(isExportStatus) ? statuses : null;
};

const findJob = async (
	event: APIGatewayProxyEvent,
	context: TenantContext,
	{ label, target }: ExportJobResource,
): Promise<{ job: ExportJobDocument } | { response: APIGatewayProxyResult }> => {
	const jobId = event.pathParameters?.jobId;
	if (!jobId) {
		return { response: ResponseWrapper.badRequest("Job id - 'jobId' is required in path parameters") };
	}

	const validationError = validateAllObjectIds({ jobId });
	if (validationError) return { response: validationError };

	const job = await getExportJobByIdForUser({
		jobId: new ObjectId(jobId),
		workspaceId: context.workspaceId,
		requestedBySub: context.cognitoSub,
		target,
	});

	return job ? { job } : { response: ResponseWrapper.notFound(`${label} export job not found`) };
};

/**
 * Builds the handler that lists the caller's export jobs for one resource.
 * @param {ExportJobResource} resource Job label and targets
 * @return {Handler} Lambda handler
 */
export const createListExportJobsHandler = ({ label, target }: ExportJobResource): Handler =>
	withExportJobContext(
		`Get ${label.toLowerCase()} export jobs handler failed`,
		`Failed to fetch ${label.toLowerCase()} export jobs`,
		async (event, context) => {
			const query = event.queryStringParameters ?? {};
			const page = Number.parseInt(query.page ?? '1', 10);
			if (!Number.isFinite(page) || page < 1) {
				return ResponseWrapper.badRequest('page must be a number greater than or equal to 1.');
			}

			const statuses = parseStatusFilters(query.status);
			if (statuses === null) {
				return ResponseWrapper.badRequest('status query parameter contains invalid value');
			}

			if (query.targetId && !ObjectId.isValid(query.targetId)) {
				return ResponseWrapper.badRequest('targetId must be a valid id.');
			}

			const { jobs, pagination, hasActiveJobs, activeJobsCount } = await listExportJobsForUser({
				requestedBySub: context.cognitoSub,
				workspaceId: context.workspaceId,
				target,
				targetId: query.targetId ? new ObjectId(query.targetId) : undefined,
				statuses,
				page,
			});

			return ResponseWrapper.success({
				message: `${label} export jobs fetched successfully`,
				result: { jobs: jobs.map(toExportJobSummary), hasActiveJobs, activeJobsCount, pagination },
			});
		},
	);

/**
 * Builds the handler that returns one of the caller's export jobs.
 * @param {ExportJobResource} resource Job label and targets
 * @return {Handler} Lambda handler
 */
export const createGetExportJobHandler = (resource: ExportJobResource): Handler =>
	withExportJobContext(
		`Get ${resource.label.toLowerCase()} export job handler failed`,
		`Failed to fetch ${resource.label.toLowerCase()} export job`,
		async (event, context) => {
			const found = await findJob(event, context, resource);
			if ('response' in found) return found.response;

			return ResponseWrapper.success({
				message: `${resource.label} export job fetched successfully`,
				result: toExportJobSummary(found.job),
			});
		},
	);

/**
 * Builds the handler that signs a download URL for a completed export job.
 * @param {ExportJobResource} resource Job label and targets
 * @return {Handler} Lambda handler
 */
export const createDownloadExportJobHandler = (resource: ExportJobResource): Handler =>
	withExportJobContext(
		`Download ${resource.label.toLowerCase()} export job handler failed`,
		'Failed to generate export download URL',
		async (event, context) => {
			const found = await findJob(event, context, resource);
			if ('response' in found) return found.response;
			const { job } = found;

			if (job.status !== 'completed' || !job.s3Key) {
				return ResponseWrapper.badRequest('Export is not ready for download');
			}

			const secondsUntilExpiry = Math.floor((job.expiresAt.getTime() - Date.now()) / 1000);
			if (secondsUntilExpiry <= 0) {
				return ResponseWrapper.badRequest('Export file has expired');
			}

			const downloadUrl = await createExportPresignedGetUrl(job.s3Key, job.fileName, secondsUntilExpiry);

			return ResponseWrapper.success({
				message: 'Export download URL generated successfully',
				result: {
					jobId: job._id.toString(),
					downloadUrl,
					fileName: job.fileName,
					contentType: job.contentType,
					expiresAt: job.expiresAt.toISOString(),
				},
			});
		},
	);
