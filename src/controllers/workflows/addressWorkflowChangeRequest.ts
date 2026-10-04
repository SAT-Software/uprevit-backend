import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ACTIVE_WORKFLOW_STATUSES } from '../../models/workflow';
import { WORKFLOW_DISCUSSION_COLLECTION, type WorkflowDiscussionItem } from '../../models/workflowDiscussion';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { getProductTeamIds, lockActiveWorkflow, scopeLabel, scopeTeamIds, workflowDiscussion } from '../../utils/workflowDiscussion';
import { parseJsonObject } from '../../utils/workflowInput';
import {
	WorkflowConflictError,
	getActorSnapshot,
	notifyWorkflow,
	parseWorkflowText,
	workflowEvents,
} from '../../utils/workflowLifecycle';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Marks an open change request as addressed with a note, then notifies the requester. Only an owner or contributor of the
 * scoped Product (any included Product for the whole workflow) may do this. Addressing is not an approval.
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
		const note = parseWorkflowText(input.note, { label: 'Note', required: true });
		if ('error' in note) return ResponseWrapper.badRequest(note.error!);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');

		const itemId = event.pathParameters?.itemId;
		const discussion = await workflowDiscussion(db);
		const item = itemId && ObjectId.isValid(itemId)
			? await discussion.findOne({ _id: new ObjectId(itemId), workspaceId: context.workspaceId, workflowId: workflow._id })
			: null;
		if (!item || item.kind !== 'change_request') return ResponseWrapper.notFound('Change request not found');
		if (!ACTIVE_WORKFLOW_STATUSES.includes(workflow.status)) return ResponseWrapper.conflict('This workflow has already ended');
		if (item.status !== 'open') return ResponseWrapper.conflict('This change request is already addressed');

		const team = scopeTeamIds(await getProductTeamIds(db, workflow), item.scope);
		if (!team.some((id) => id.equals(context.userId))) {
			return ResponseWrapper.forbidden(item.scope.type === 'product'
				? 'Only the owner or a contributor of this Product can address this request'
				: 'Only an owner or contributor of a Product in this workflow can address this request');
		}

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can address change requests');

		const now = new Date();
		const events = await workflowEvents(db);
		const addressed = await withTransaction(async (txDb, session) => {
			await lockActiveWorkflow(txDb, workflow, session, now);
			const updated = await txDb.collection<WorkflowDiscussionItem>(WORKFLOW_DISCUSSION_COLLECTION).findOneAndUpdate(
				{ _id: item._id, workspaceId: context.workspaceId, status: 'open' },
				{ $set: { status: 'addressed', addressedBySnapshot: actor, addressNote: note.value!, addressedAt: now } },
				{ returnDocument: 'after', session },
			);
			if (!updated) throw new WorkflowConflictError('This change request is already addressed');

			await events.insertOne({
				workspaceId: context.workspaceId,
				workflowId: workflow._id!,
				type: 'change_request_addressed',
				actorSnapshot: actor,
				...(item.assignmentId && { assignmentId: item.assignmentId }),
				...(item.scope.type === 'product' && { lineageId: item.scope.lineageId }),
				comment: note.value!,
				data: { discussionItemId: item._id, requestedBy: item.authorSnapshot.name },
				createdAt: now,
			}, { session });

			return updated;
		});

		await notifyWorkflow({
			workflow,
			actorId: actor.userId,
			recipients: [item.authorSnapshot.userId],
			type: 'workflow.change_request_addressed',
			title: `${actor.name} addressed your change request on ${workflow.numberLabel}`,
			body: `Your request on ${scopeLabel(workflow, item.scope)} was addressed: "${note.value}". Your decision is still needed.`,
			tab: 'discussion',
		});

		return ResponseWrapper.success({ message: 'Change request addressed', item: addressed });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		if (err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		logError('Address workflow change request handler failed', err);
		return ResponseWrapper.internalServerError('Failed to address change request');
	}
};
