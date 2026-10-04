import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ACTIVE_WORKFLOW_STATUSES, WORKFLOWS_COLLECTION, type Workflow } from '../../models/workflow';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { emailNotifications, ensureNotificationIndexes, saveNotifications } from '../../utils/notifications';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { parseJsonObject } from '../../utils/workflowInput';
import { WorkflowConflictError, getActorSnapshot, parseWorkflowText, workflowEvents, workflowNotification } from '../../utils/workflowLifecycle';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Sends a manual reminder with an optional message to the chosen approvers of an active workflow. Only the Initiator
 * may do this. The selection is checked against the current workflow, and the in-app reminders and the History event
 * are saved together; emails follow once they are saved.
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
		const ids = input.assignmentIds;
		if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && ObjectId.isValid(id))) {
			return ResponseWrapper.badRequest('assignmentIds must be a non-empty list of assignment ids');
		}
		const message = parseWorkflowText(input.message, { label: 'Message', required: false });
		if ('error' in message) return ResponseWrapper.badRequest(message.error!);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');
		if (!workflow.initiator.userId.equals(context.userId)) return ResponseWrapper.forbidden('Only the Initiator can send reminders');

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can send reminders');

		const selected = new Set(ids as string[]);
		const [events] = await Promise.all([workflowEvents(db), ensureNotificationIndexes()]);
		const { users, notice, names } = await withTransaction(async (txDb, session) => {
			const now = new Date();
			const current = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
				{ _id: workflow._id, workspaceId: context.workspaceId, status: { $in: ACTIVE_WORKFLOW_STATUSES } },
				{ $set: { remindedAt: now } },
				{ returnDocument: 'after', session },
			);
			if (!current) throw new WorkflowConflictError('Reminders can only be sent while the workflow is active');

			const assignments = current.assignments.filter((assignment) => selected.has(assignment._id.toString()));
			if (assignments.length !== selected.size) throw new WorkflowConflictError('The approvers changed. Reload and pick again.');

			const notice = workflowNotification({
				workflow: current,
				actorId: actor.userId,
				recipients: assignments.map((assignment) => assignment.userId),
				type: 'workflow.reminder',
				title: `${actor.name} sent a reminder about ${current.numberLabel}`,
				body: message.value ?? `Please review "${current.name}".`,
				tab: 'approvals',
			});
			const users = await saveNotifications(txDb, notice, session);
			if (users.length === 0) throw new WorkflowConflictError('None of the selected approvers can receive a reminder');

			const notifiedIds = new Set(users.map((user) => user._id!.toString()));
			const notified = assignments.filter((assignment) => notifiedIds.has(assignment.userId.toString()));
			const names = [...new Set(notified.map((assignment) => assignment.userSnapshot.name))];
			await events.insertOne({
				workspaceId: context.workspaceId,
				workflowId: current._id!,
				type: 'reminder_sent',
				actorSnapshot: actor,
				...(message.value && { comment: message.value }),
				data: { assignmentIds: notified.map((assignment) => assignment._id), notified: names },
				createdAt: now,
			}, { session });

			return { users, notice, names };
		});

		await emailNotifications(users, notice);
		return ResponseWrapper.success({ message: 'Reminder sent', notified: names });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		if (err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		logError('Send workflow reminder handler failed', err);
		return ResponseWrapper.internalServerError('Failed to send reminder');
	}
};
