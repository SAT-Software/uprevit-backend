import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { workflowEvents } from '../../utils/workflowLifecycle';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Returns a workflow's history events, newest first.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db } = workflowResult;
		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');

		const events = await (await workflowEvents(db))
			.find({ workspaceId: context.workspaceId, workflowId: workflow._id })
			.sort({ createdAt: -1, _id: -1 })
			.toArray();

		return ResponseWrapper.success({ message: 'Workflow history fetched successfully', events });
	} catch (err) {
		logError('Get workflow history handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get workflow history');
	}
};
