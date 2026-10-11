import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { UNDECIDED_DECISIONS } from '../../models/workflow';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { WorkflowReplacementError, replaceAssignment } from '../../utils/workflowAssignments';
import { parseJsonObject } from '../../utils/workflowInput';
import { WorkflowConflictError, getActorSnapshot, parseWorkflowText, withContentChangeFlags } from '../../utils/workflowLifecycle';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Replaces an approver who has not decided yet with another eligible member, with a required reason. Only the
 * Initiator may do this. Decisions already made stay with the original approver.
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
		if (typeof input.userId !== 'string' || !ObjectId.isValid(input.userId)) return ResponseWrapper.badRequest('A valid userId is required');
		const reason = parseWorkflowText(input.reason, { label: 'Reason', required: true });
		if ('error' in reason) return ResponseWrapper.badRequest(reason.error!);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');
		if (!workflow.initiator.userId.equals(context.userId)) return ResponseWrapper.forbidden('Only the Initiator can replace an approver');

		const assignmentId = event.pathParameters?.assignmentId;
		const assignment = assignmentId && ObjectId.isValid(assignmentId)
			? workflow.assignments.find((item) => item._id.equals(new ObjectId(assignmentId)))
			: undefined;
		if (!assignment) return ResponseWrapper.notFound('Assignment not found');
		if (workflow.status !== 'in_review') return ResponseWrapper.conflict('Approvers can only be replaced while the workflow is In Review');
		if (!UNDECIDED_DECISIONS.includes(assignment.decision)) {
			return ResponseWrapper.conflict(`${assignment.userSnapshot.name} already decided, so they can't be replaced`);
		}

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can replace approvers');

		const updated = await replaceAssignment({
			db,
			workflowId: workflow._id!,
			workspaceId: context.workspaceId,
			assignmentId: assignment._id,
			userId: new ObjectId(input.userId),
			reason: reason.value!,
			actor,
			auth: auth.payload,
		});
		return ResponseWrapper.success({
			message: 'Approver replaced',
			workflow: { ...updated, assignments: await withContentChangeFlags(db, updated) },
		});
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		if (err instanceof WorkflowReplacementError) return ResponseWrapper.badRequest(err.message);
		if (err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		logError('Replace workflow assignment handler failed', err);
		return ResponseWrapper.internalServerError('Failed to replace approver');
	}
};
