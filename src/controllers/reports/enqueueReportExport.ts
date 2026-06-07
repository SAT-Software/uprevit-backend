import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { EXPORT_JOB_COLLECTION, EXPORT_JOB_FORMATS, type ExportJobFormat } from '../../models/exportJob';
import { authenticateRequest } from '../../utils/authUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';
import { getDb } from '../../utils/db';
import { createQueuedExportJob } from '../../utils/exportJobs';
import { enqueueExportJobMessage } from '../../utils/exportQueue';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateConditions } from '../../utils/reports/queryBuilder';
import { validateMissingFields, validateObjectIds } from '../../utils/validationUtils';
import type { PersistedReportExportRequest, QueryCondition } from '../../types/reports';
import { ALLOWED_SORT_FIELDS } from '../../types/reports';
import { assertUsageActionAllowed } from '../../utils/billing/enforcement';

type RequestBody = {
	workspaceId?: string;
	format?: unknown;
	conditions?: unknown;
	conditionLogic?: unknown;
	sort?: {
		field?: unknown;
		order?: unknown;
	};
};

/**
 * Queues a reports export job from request body format and filters.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Accepted response with job id
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	if (!event.body) {
		return ResponseWrapper.badRequest('Request body is required');
	}

	let format: ExportJobFormat | undefined;

	try {
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(event.body);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return ResponseWrapper.badRequest('Request body contains invalid JSON');
			}

			throw error;
		}

		if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
			return ResponseWrapper.badRequest('Request body must be a JSON object');
		}

		const body = parsedBody as RequestBody;
		const missingFieldsResult = validateMissingFields({ workspaceId: body.workspaceId || '' });
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateObjectIds({ workspaceId: body.workspaceId! });
		if (objectIdValidation) return objectIdValidation;

		if (typeof body.format !== 'string' || !EXPORT_JOB_FORMATS.includes(body.format as ExportJobFormat)) {
			return ResponseWrapper.badRequest(`Request body must include 'format' and must be one of: ${EXPORT_JOB_FORMATS.join(', ')}`);
		}

		format = body.format as ExportJobFormat;

		if (body.conditionLogic && body.conditionLogic !== 'AND' && body.conditionLogic !== 'OR') {
			return ResponseWrapper.badRequest('conditionLogic must be either "AND" or "OR"');
		}

		if (body.conditions !== undefined && !Array.isArray(body.conditions)) {
			return ResponseWrapper.badRequest('conditions must be an array');
		}

		const conditions = (body.conditions ?? []) as QueryCondition[];
		if (conditions.length > 0) {
			const conditionError = validateConditions(conditions);
			if (conditionError) return conditionError;
		}

		if (body.sort) {
			if (typeof body.sort !== 'object' || Array.isArray(body.sort)) {
				return ResponseWrapper.badRequest('sort must be an object');
			}

			if (typeof body.sort.field !== 'string' || !ALLOWED_SORT_FIELDS.includes(body.sort.field)) {
				return ResponseWrapper.badRequest(`sort.field must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`);
			}

			if (body.sort.order !== 'asc' && body.sort.order !== 'desc') {
				return ResponseWrapper.badRequest('sort.order must be either "asc" or "desc"');
			}
		}

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

		const requestedWorkspaceId = new ObjectId(body.workspaceId);
		if (requestedWorkspaceId.toString() !== userContext.workspaceId.toString()) {
			return ResponseWrapper.forbidden('You are not authorized to export reports for this workspace');
		}

		const exportCheck = await assertUsageActionAllowed(userContext.workspaceId, 'export', 1);
		if (!exportCheck.allowed) return ResponseWrapper.forbidden(exportCheck.reason);

		const reportParams: PersistedReportExportRequest = {
			conditions,
			...(body.conditionLogic ? { conditionLogic: body.conditionLogic as 'AND' | 'OR' } : {}),
			...(body.sort ? { sort: { field: body.sort.field as string, order: body.sort.order as 'asc' | 'desc' } } : {}),
		};

		const job = await createQueuedExportJob({
			target: 'report',
			workspaceId: userContext.workspaceId,
			requestedBySub: cognitoSub,
			requestedByUserId: userContext.userId,
			format,
			reportParams,
		});

		try {
			await enqueueExportJobMessage({
				schemaVersion: 1,
				jobId: job._id.toString(),
				target: 'report',
				workspaceId: userContext.workspaceId.toString(),
				requestedBySub: cognitoSub,
				requestedByUserId: userContext.userId.toString(),
				format,
				queuedAt: job.createdAt.toISOString(),
			});
		} catch (queueError) {
			const db = await getDb();
			await db.collection(EXPORT_JOB_COLLECTION).deleteOne({ _id: job._id });
			throw queueError;
		}

		return ResponseWrapper.accepted({
			message: 'Report export queued successfully',
			result: {
				jobId: job._id.toString(),
				status: job.status,
			},
		});
	} catch (error) {
		logError('Failed to queue report export', error, { format });
		return ResponseWrapper.internalServerError('Failed to queue report export');
	}
};
