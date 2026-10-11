import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { WORKFLOW_COMPLETION_MODES, WORKFLOWS_COLLECTION, type Workflow, type WorkflowCompletionMode } from '../../models/workflow';
import type { User } from '../../models/user';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { ensureWorkflowPrefix, formatWorkflowNumber, nextWorkflowNumber } from '../../utils/workflowNumber';
import { requireWorkflowContext } from '../../utils/workflows';
import { parseJsonObject, parseWorkflowDetails } from '../../utils/workflowInput';

/**
 * Creates a workflow Draft with a new Workflow Number.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db, workspace } = workflowResult;
		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = parseJsonObject(event.body);
		if (!input) return ResponseWrapper.badRequest('Request body must be a JSON object');

		const details = parseWorkflowDetails(input, { required: true });
		if ('error' in details) return ResponseWrapper.badRequest(details.error);

		const initiator = await db.collection<User>('users').findOne(
			{ _id: context.userId, workspaceId: context.workspaceId, status: 'active' },
			{ projection: { name: 1, email: 1 } },
		);
		if (!initiator) return ResponseWrapper.forbidden('Only active members can create workflows');

		const prefix = await ensureWorkflowPrefix(db, workspace);
		const number = await nextWorkflowNumber(db, context.workspaceId);
		const defaultMode: WorkflowCompletionMode = WORKFLOW_COMPLETION_MODES.includes(workspace.defaultWorkflowCompletionMode!)
			? workspace.defaultWorkflowCompletionMode!
			: 'automatic';

		const workflow: Workflow = {
			workspaceId: context.workspaceId,
			number,
			numberLabel: formatWorkflowNumber(prefix, number),
			name: details.value.name!,
			description: details.value.description!,
			status: 'draft',
			completionMode: details.value.completionMode ?? defaultMode,
			initiator: { userId: context.userId, name: initiator.name, email: initiator.email },
			products: [],
			assignments: [],
			dates: { createdAt: new Date() },
		};
		const inserted = await db.collection<Workflow>(WORKFLOWS_COLLECTION).insertOne(workflow);

		return ResponseWrapper.created({
			message: 'Workflow created successfully',
			workflow: { ...workflow, _id: inserted.insertedId },
		});
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		logError('Create workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create workflow');
	}
};
