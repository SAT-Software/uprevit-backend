import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { WORKFLOWS_COLLECTION, type Workflow } from '../../models/workflow';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import {
	WORKFLOW_NOT_DRAFT_MESSAGE,
	canManageWorkflow,
	findWorkflow,
	requireWorkflowContext,
} from '../../utils/workflows';

/**
 * Deletes a Draft workflow. Its Workflow Number is never reused.
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
		if (!canManageWorkflow(context, workflow)) return ResponseWrapper.forbidden('Only the Initiator or an admin can delete this workflow');
		if (workflow.status !== 'draft') return ResponseWrapper.conflict('Only Draft workflows can be deleted');

		const workflowId = workflow._id!.toString();
		const deleted = await withTransaction(async (txDb, session) => {
			const result = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).deleteOne({ _id: workflow._id, status: 'draft' }, { session });
			if (result.deletedCount === 0) return false;
			await recordAuditEvent({
				workspaceId: context.workspaceId.toString(),
				scope: { type: 'workflow', id: workflowId },
				entity: { type: 'workflow', id: workflowId },
				action: 'delete',
				eventKey: 'workflow.deleted',
				visibility: 'all',
				where: { module: 'workflows' },
				auth: auth.payload,
				before: workflow as unknown as Record<string, unknown>,
				meta: { workflowNumber: workflow.numberLabel, workflowName: workflow.name },
				session,
			});
			return true;
		});
		if (!deleted) return ResponseWrapper.conflict(WORKFLOW_NOT_DRAFT_MESSAGE);

		return ResponseWrapper.success({ message: 'Workflow deleted successfully' });
	} catch (err) {
		logError('Delete workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to delete workflow');
	}
};
