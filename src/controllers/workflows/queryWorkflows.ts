import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { WORKFLOWS_COLLECTION, type Workflow } from '../../models/workflow';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { buildWorkflowQueryMatch, validateWorkflowQuery, type WorkflowQueryCondition } from '../../utils/workflowQuery';
import { requireWorkflowContext } from '../../utils/workflows';

const MAX_LIMIT = 100;

/**
 * Advanced workflow search: up to 10 conditions chained with AND or OR, newest first.
 * Body: `{ conditions: [{ field, operator, value?, logic? }], pagination?: { page, limit } }`.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db } = workflowResult;

		let input: { conditions?: unknown; pagination?: { page?: unknown; limit?: unknown } };
		try {
			input = JSON.parse(event.body || '{}');
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		if (typeof input !== 'object' || input === null || Array.isArray(input)) return ResponseWrapper.badRequest('Request body must be an object');

		const conditionError = validateWorkflowQuery(input.conditions);
		if (conditionError) return ResponseWrapper.badRequest(conditionError);

		const page = Number(input.pagination?.page ?? 1);
		const limit = Number(input.pagination?.limit ?? 10);
		if (!Number.isInteger(page) || page < 1) return ResponseWrapper.badRequest('page must be a positive integer');
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
			return ResponseWrapper.badRequest(`limit must be between 1 and ${MAX_LIMIT}`);
		}

		const filter = {
			$and: [{ workspaceId: context.workspaceId }, buildWorkflowQueryMatch(input.conditions as WorkflowQueryCondition[])],
		};
		const workflows = db.collection<Workflow>(WORKFLOWS_COLLECTION);
		const [items, totalCount] = await Promise.all([
			workflows.find(filter).sort({ 'dates.createdAt': -1, '_id': -1 }).skip((page - 1) * limit).limit(limit).toArray(),
			workflows.countDocuments(filter),
		]);
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Workflows fetched successfully',
			result: {
				workflows: items,
				pagination: {
					currentPage: page,
					totalPages,
					totalCount,
					limit,
					hasNextPage: page < totalPages,
					hasPrevPage: page > 1,
				},
			},
		});
	} catch (err) {
		logError('Query workflows handler failed', err);
		return ResponseWrapper.internalServerError('Failed to search workflows');
	}
};
