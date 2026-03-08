import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { ExportJobStatus } from '../../models/exportJob';
import { authenticateRequest } from '../../utils/authUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';
import { toExportJobSummary } from '../../utils/exportJobSerializers';
import { isExportStatus, listExportJobsForUser } from '../../utils/exportJobs';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';

/**
 * Lists report export jobs for authenticated user.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Report export jobs list response
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const cognitoSub = auth.payload.sub;
		if (!cognitoSub) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const userContext = await getAuthenticatedUserContext(cognitoSub);
		if (!userContext) {
			return ResponseWrapper.unauthorized('Unable to resolve authenticated user context');
		}

		const page = Number.parseInt(event.queryStringParameters?.page ?? '1', 10);
		if (!Number.isFinite(page) || page < 1) {
			return ResponseWrapper.badRequest('page must be a number greater than or equal to 1.');
		}

		const statusQuery = event.queryStringParameters?.status;
		let statuses: ExportJobStatus[] | undefined;

		try {
			statuses = parseStatusFilters(statusQuery);
		} catch (error) {
			return ResponseWrapper.badRequest(error instanceof Error ? error.message : 'Invalid status filter');
		}

		const { jobs, pagination, hasActiveJobs, activeJobsCount } = await listExportJobsForUser({
			requestedBySub: cognitoSub,
			workspaceId: userContext.workspaceId,
			target: 'report',
			statuses,
			page,
		});

		return ResponseWrapper.success({
			message: 'Report export jobs fetched successfully',
			result: {
				jobs: jobs.map(toExportJobSummary),
				hasActiveJobs,
				activeJobsCount,
				pagination,
			},
		});
	} catch (error) {
		logError('Get report export jobs handler failed', error);
		return ResponseWrapper.internalServerError('Failed to fetch report export jobs');
	}
};

const parseStatusFilters = (statusQuery?: string): ExportJobStatus[] | undefined => {
	if (!statusQuery || !statusQuery.trim()) return undefined;

	const parsedStatuses = statusQuery
		.split(',')
		.map((status) => status.trim())
		.filter(Boolean);

	if (!parsedStatuses.length) return undefined;

	for (const status of parsedStatuses) {
		if (!isExportStatus(status)) {
			throw new Error('status query parameter contains invalid value');
		}
	}

	return parsedStatuses as ExportJobStatus[];
};
