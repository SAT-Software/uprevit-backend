import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { findWorkflow, getWorkflowReadiness, requireWorkflowContext } from '../../utils/workflows';

/**
 * Returns the "ready to start?" checklist for a workflow.
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

		const checks = await getWorkflowReadiness(db, workflow);

		return ResponseWrapper.success({
			message: 'Workflow readiness fetched successfully',
			readiness: { ready: checks.every((check) => check.passed), checks },
		});
	} catch (err) {
		logError('Get workflow readiness handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get workflow readiness');
	}
};
