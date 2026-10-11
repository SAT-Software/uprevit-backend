import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ACTIVE_WORKFLOW_STATUSES } from '../../models/workflow';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { parseJsonObject } from '../../utils/workflowInput';
import {
	WorkflowConflictError,
	endWorkflowWithoutRelease,
	getActorSnapshot,
	parseWorkflowText,
} from '../../utils/workflowLifecycle';
import { canManageWorkflow, findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Cancels a started workflow with a reason. Only the Initiator or an admin may do this.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, auth, db } = workflowResult;
		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
		const input = parseJsonObject(event.body);
		if (!input) return ResponseWrapper.badRequest('Request body must be a JSON object');
		const reason = parseWorkflowText(input.reason, { label: 'Reason', required: true });
		if ('error' in reason) return ResponseWrapper.badRequest(reason.error!);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');
		if (!canManageWorkflow(context, workflow)) return ResponseWrapper.forbidden('Only the Initiator or an admin can cancel this workflow');
		if (!ACTIVE_WORKFLOW_STATUSES.includes(workflow.status)) {
			return ResponseWrapper.conflict(workflow.status === 'draft'
				? 'Draft workflows are deleted, not cancelled'
				: 'This workflow has already ended');
		}

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can cancel workflows');

		const ended = await endWorkflowWithoutRelease({ db, workflow, outcome: 'cancelled', actor, reason: reason.value!, auth: auth.payload });
		return ResponseWrapper.success({ message: 'Workflow cancelled', workflow: ended });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		if (err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		logError('Cancel workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to cancel workflow');
	}
};
