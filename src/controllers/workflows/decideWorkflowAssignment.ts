import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ACTIVE_WORKFLOW_STATUSES, UNDECIDED_DECISIONS, WORKFLOWS_COLLECTION, type Workflow } from '../../models/workflow';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { LifecycleConflictError } from '../../utils/productLifecycle';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { parseDiscussionAttachments, parseDiscussionScope, requestChanges } from '../../utils/workflowDiscussion';
import { isStillEligible } from '../../utils/workflowAssignments';
import { parseJsonObject } from '../../utils/workflowInput';
import {
	WorkflowConflictError,
	contentChangedSince,
	countOpenChangeRequests,
	endWorkflowWithoutRelease,
	evaluateCompletion,
	getActorSnapshot,
	getContentCheckpoint,
	notifyApproval,
	parseWorkflowText,
	withContentChangeFlags,
	workflowEvents,
} from '../../utils/workflowLifecycle';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

const DECISIONS = ['approve', 'reject', 'request_changes'] as const;
type Decision = typeof DECISIONS[number];

/**
 * Records the assigned approver's decision. Approve takes an optional comment and, once everyone has approved, completes
 * the workflow or makes it ready to complete; on an approval older than the latest content it records an Approve again
 * instead. Reject needs a reason and ends the workflow; Request Changes needs a reason and a scope, optionally with images, and blocks completion
 * until the request is addressed and the approver decides again. Every decision re-enables the approver's Change Notice.
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

		const decision = input.decision as Decision;
		if (!DECISIONS.includes(decision)) return ResponseWrapper.badRequest(`decision must be one of: ${DECISIONS.join(', ')}`);
		const text = decision === 'approve'
			? parseWorkflowText(input.comment, { label: 'Comment', required: false })
			: parseWorkflowText(input.reason, { label: 'Reason', required: true });
		if ('error' in text) return ResponseWrapper.badRequest(text.error!);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');

		const assignmentId = event.pathParameters?.assignmentId;
		const assignment = assignmentId && ObjectId.isValid(assignmentId)
			? workflow.assignments.find((item) => item._id.equals(new ObjectId(assignmentId)))
			: undefined;
		if (!assignment) return ResponseWrapper.notFound('Assignment not found');
		if (!assignment.userId.equals(context.userId)) return ResponseWrapper.forbidden('Only the assigned approver can decide');
		if (assignment.needsReplacement) {
			return ResponseWrapper.conflict('You can no longer approve for this assignment. The Initiator needs to replace you.');
		}
		if (!(await isStillEligible(db, context.workspaceId, assignment))) {
			return ResponseWrapper.conflict('You are no longer on this Product\'s team, so you can\'t decide for it.');
		}

		const isReconfirm = decision === 'approve' && assignment.decision === 'approved';
		if (decision === 'request_changes' || isReconfirm) {
			if (!ACTIVE_WORKFLOW_STATUSES.includes(workflow.status)) return ResponseWrapper.conflict('This workflow has already ended');
			if (assignment.decision === 'rejected') return ResponseWrapper.conflict('You have already rejected this workflow');
		} else {
			if (workflow.status !== 'in_review') return ResponseWrapper.conflict('Decisions can only be made while the workflow is In Review');
			if (!UNDECIDED_DECISIONS.includes(assignment.decision)) return ResponseWrapper.conflict('You have already decided on this assignment');
		}
		const scope = decision === 'request_changes' ? parseDiscussionScope(input.scope, workflow) : undefined;
		if (scope && 'error' in scope) return ResponseWrapper.badRequest(scope.error);

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can decide');

		if (scope) {
			const attachments = await parseDiscussionAttachments(input.attachments, workflow, context.userId);
			if ('error' in attachments) return ResponseWrapper.badRequest(attachments.error);
			const updated = await requestChanges({
				db, workflow, assignment, actor, scope: scope.value, reason: text.value!, attachments: attachments.value,
			});
			return ResponseWrapper.success({ message: 'Change request recorded', workflow: updated });
		}

		if (decision === 'reject') {
			const ended = await endWorkflowWithoutRelease({
				db, workflow, outcome: 'rejected', actor, reason: text.value!, auth: auth.payload, rejection: { assignmentId: assignment._id },
			});
			return ResponseWrapper.success({ message: 'Workflow rejected', workflow: ended });
		}

		const now = new Date();
		const comment = text.value;
		const events = await workflowEvents(db);

		if (isReconfirm) {
			const reconfirmed = await withTransaction(async (txDb, session) => {
				const contentCheckpoint = await getContentCheckpoint(txDb, workflow, session);
				if (!contentChangedSince(assignment.contentCheckpoint ?? {}, contentCheckpoint)) {
					throw new WorkflowConflictError('Your approval already covers the latest content');
				}
				const result = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
					{
						_id: workflow._id,
						workspaceId: context.workspaceId,
						status: { $in: ACTIVE_WORKFLOW_STATUSES },
						assignments: {
							$elemMatch: { _id: assignment._id, userId: context.userId, decision: 'approved', decidedAt: assignment.decidedAt, needsReplacement: { $exists: false } },
						},
					},
					{
						$set: {
							'assignments.$.decidedAt': now,
							'assignments.$.contentCheckpoint': contentCheckpoint,
							'assignments.$.changeNoticeSent': false,
							...(comment && { 'assignments.$.comment': comment }),
						},
						...(!comment && { $unset: { 'assignments.$.comment': '' } }),
					},
					{ returnDocument: 'after', session },
				);
				if (!result) throw new WorkflowConflictError('This workflow or assignment changed. Reload and try again.');

				await events.insertOne({
					workspaceId: context.workspaceId,
					workflowId: workflow._id!,
					type: 'approval_reconfirmed',
					actorSnapshot: actor,
					assignmentId: assignment._id,
					...(assignment.lineageId && { lineageId: assignment.lineageId }),
					...(comment && { comment }),
					data: { functionLabel: assignment.functionLabel, contentCheckpoint, previousCheckpoint: assignment.contentCheckpoint },
					createdAt: now,
				}, { session });

				return result;
			});
			return ResponseWrapper.success({
				message: 'Approval recorded on the latest content',
				workflow: { ...reconfirmed, assignments: await withContentChangeFlags(db, reconfirmed) },
			});
		}

		const updated = await withTransaction(async (txDb, session) => {
			if (await countOpenChangeRequests(txDb, workflow, { assignmentId: assignment._id, session }) > 0) {
				throw new WorkflowConflictError('Your change request is still open. You can approve once it is addressed.');
			}
			const contentCheckpoint = await getContentCheckpoint(txDb, workflow, session);
			const approved = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
				{
					_id: workflow._id,
					workspaceId: context.workspaceId,
					status: 'in_review',
					assignments: { $elemMatch: { _id: assignment._id, userId: context.userId, decision: { $in: UNDECIDED_DECISIONS }, needsReplacement: { $exists: false } } },
				},
				{
					$set: {
						'assignments.$.decision': 'approved',
						'assignments.$.decidedAt': now,
						'assignments.$.contentCheckpoint': contentCheckpoint,
						'assignments.$.changeNoticeSent': false,
						...(comment && { 'assignments.$.comment': comment }),
					},
				},
				{ returnDocument: 'after', session },
			);
			if (!approved) throw new WorkflowConflictError('This workflow or assignment changed. Reload and try again.');

			await events.insertOne({
				workspaceId: context.workspaceId,
				workflowId: workflow._id!,
				type: 'approved',
				actorSnapshot: actor,
				assignmentId: assignment._id,
				...(assignment.lineageId && { lineageId: assignment.lineageId }),
				...(comment && { comment }),
				data: { functionLabel: assignment.functionLabel, contentCheckpoint },
				createdAt: now,
			}, { session });

			return evaluateCompletion({ db: txDb, session, workflow: approved, actor, auth: auth.payload });
		});

		await notifyApproval(db, updated, actor, assignment.functionLabel);
		return ResponseWrapper.success({
			message: 'Approval recorded',
			workflow: { ...updated, assignments: await withContentChangeFlags(db, updated) },
		});
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		if (err instanceof WorkflowConflictError || err instanceof LifecycleConflictError) return ResponseWrapper.conflict(err.message);
		logError('Decide workflow assignment handler failed', err);
		return ResponseWrapper.internalServerError('Failed to record decision');
	}
};
