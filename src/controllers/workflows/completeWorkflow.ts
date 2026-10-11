import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { LifecycleConflictError } from '../../utils/productLifecycle';
import { ResponseWrapper } from '../../utils/responseWrapper';
import {
	WorkflowConflictError,
	completeWorkflow,
	getActorSnapshot,
	notifyCompletion,
	workflowEvents,
} from '../../utils/workflowLifecycle';
import { canManageWorkflow, findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Completes a Ready to Complete workflow, releasing its Products. Only the Initiator or an admin may do this.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, auth, db } = workflowResult;
		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');
		if (!canManageWorkflow(context, workflow)) return ResponseWrapper.forbidden('Only the Initiator or an admin can complete this workflow');
		if (workflow.status !== 'ready_to_complete') return ResponseWrapper.conflict('Only Ready to Complete workflows can be completed');

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can complete workflows');

		await workflowEvents(db);
		const completed = await withTransaction((txDb, session) => completeWorkflow({ db: txDb, session, workflow, actor, auth: auth.payload }));

		await notifyCompletion(db, completed, actor);
		return ResponseWrapper.success({ message: 'Workflow completed', workflow: completed });
	} catch (err) {
		if (err instanceof WorkflowConflictError || err instanceof LifecycleConflictError) return ResponseWrapper.conflict(err.message);
		logError('Complete workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to complete workflow');
	}
};
