import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { ExportJobStatus } from '../../models/exportJob';
import { authenticateRequest } from '../../utils/authUtils';
import { toExportJobSummary } from '../../utils/exportJobSerializers';
import { logError } from '../../utils/logger';
import {
	isProductExportStatus,
	listProductExportJobsForUser,
} from '../../utils/productExportJobs';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';

/**
 * Lists export jobs for authenticated user.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Product export jobs list response
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

		const { jobs, pagination } = await listProductExportJobsForUser({
			requestedBySub: cognitoSub,
			workspaceId: userContext.workspaceId,
			target: 'product',
			statuses,
			page,
		});

		return ResponseWrapper.success({
			message: 'Product export jobs fetched successfully',
			result: {
				jobs: jobs.map(toExportJobSummary),
				pagination,
			},
		});
	} catch (error) {
		logError('Get product export jobs handler failed', error);
		return ResponseWrapper.internalServerError('Failed to fetch product export jobs');
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
		if (!isProductExportStatus(status)) {
			throw new Error('status query parameter contains invalid value');
		}
	}

	return parsedStatuses as ExportJobStatus[];
};
