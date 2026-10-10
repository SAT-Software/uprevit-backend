import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ACTIVE_WORKFLOW_STATUSES } from '../../models/workflow';
import type { WorkflowDiscussionItem } from '../../models/workflowDiscussion';
import { assertNewUploadCommitsAllowed } from '../../utils/billing/uploadCommit';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import {
	canComment,
	getProductTeamIds,
	lockActiveWorkflow,
	parseDiscussionAttachments,
	parseDiscussionScope,
	recordAttachmentUploads,
	withAttachmentUrls,
	workflowDiscussion,
} from '../../utils/workflowDiscussion';
import { parseJsonObject } from '../../utils/workflowInput';
import { WorkflowConflictError, getActorSnapshot, parseWorkflowText } from '../../utils/workflowLifecycle';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Adds a comment on one Product or the whole workflow. The Initiator, assigned approvers, the included Products' owners
 * and contributors, and admins may comment while the workflow is active, optionally with images they uploaded to this
 * workflow. Comments do not send notifications.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db } = workflowResult;
		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
		const input = parseJsonObject(event.body);
		if (!input) return ResponseWrapper.badRequest('Request body must be a JSON object');
		const body = parseWorkflowText(input.body, { label: 'Comment', required: true });
		if ('error' in body) return ResponseWrapper.badRequest(body.error!);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');
		const scope = parseDiscussionScope(input.scope, workflow);
		if ('error' in scope) return ResponseWrapper.badRequest(scope.error);
		if (!ACTIVE_WORKFLOW_STATUSES.includes(workflow.status)) {
			return ResponseWrapper.conflict('Comments can only be added while the workflow is active');
		}
		if (!canComment(context, workflow, await getProductTeamIds(db, workflow))) {
			return ResponseWrapper.forbidden('Only people involved in this workflow can comment');
		}

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can comment');
		const attachments = await parseDiscussionAttachments(input.attachments, workflow, context.userId);
		if ('error' in attachments) return ResponseWrapper.badRequest(attachments.error);
		const uploadCheck = await assertNewUploadCommitsAllowed(context.workspaceId, attachments.value);
		if (!uploadCheck.allowed) return ResponseWrapper.forbidden(uploadCheck.reason);

		const item: WorkflowDiscussionItem = {
			workspaceId: context.workspaceId,
			workflowId: workflow._id!,
			kind: 'comment',
			scope: scope.value,
			authorSnapshot: actor,
			body: body.value!,
			...(attachments.value.length > 0 && { attachments: attachments.value }),
			createdAt: new Date(),
		};
		const discussion = await workflowDiscussion(db);
		const { insertedId } = await withTransaction(async (txDb, session) => {
			await lockActiveWorkflow(txDb, workflow, session, item.createdAt);
			return discussion.insertOne(item, { session });
		});

		await recordAttachmentUploads(context.workspaceId, attachments.value);

		const [created] = await withAttachmentUrls([{ ...item, _id: insertedId }], context.workspaceId);
		return ResponseWrapper.created({ message: 'Comment added', item: created });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		if (err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		logError('Add workflow comment handler failed', err);
		return ResponseWrapper.internalServerError('Failed to add comment');
	}
};
