import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { Product } from '../../models/product';
import { WORKFLOWS_COLLECTION, type Workflow } from '../../models/workflow';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { allTabsCompletedFilter } from '../../utils/productLifecycle';
import { ResponseWrapper } from '../../utils/responseWrapper';
import {
	WorkflowConflictError,
	getActorSnapshot,
	getWorkflowParticipants,
	notifyWorkflow,
	workflowEvents,
} from '../../utils/workflowLifecycle';
import {
	WORKFLOW_EDIT_FORBIDDEN_MESSAGE,
	canManageWorkflow,
	findWorkflow,
	getWorkflowReadiness,
	requireWorkflowContext,
} from '../../utils/workflows';

/**
 * Starts a ready Draft workflow: its versions become In Review and its setup is locked.
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
		if (!canManageWorkflow(context, workflow)) return ResponseWrapper.forbidden(WORKFLOW_EDIT_FORBIDDEN_MESSAGE);
		if (workflow.status !== 'draft') return ResponseWrapper.conflict('Only Draft workflows can be started');

		const actor = await getActorSnapshot(db, context.workspaceId, context.userId);
		if (!actor) return ResponseWrapper.forbidden('Only active members can start workflows');

		const now = new Date();
		const workflowId = workflow._id!;
		const events = await workflowEvents(db);

		const started = await withTransaction(async (txDb, session) => {
			const updated = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
				{ _id: workflowId, workspaceId: context.workspaceId, status: 'draft' },
				{ $set: { 'status': 'in_review', 'dates.startedAt': now } },
				{ returnDocument: 'after', session },
			);
			if (!updated) throw new WorkflowConflictError('This workflow was already started or deleted');

			const failed = (await getWorkflowReadiness(txDb, updated, session)).filter((check) => !check.passed);
			if (failed.length) {
				throw new WorkflowConflictError(`This workflow is not ready to start. ${failed.map((check) => check.message).join('; ')}`);
			}

			const versionIds = updated.products.map((product) => product.productVersionId);
			const locked = await txDb.collection<Product>('products').updateMany(
				{
					_id: { $in: versionIds },
					workspace_id: context.workspaceId,
					status: 'submitted',
					is_latest: true,
					is_archived: { $ne: true },
					active_workflow_id: { $exists: false },
					...allTabsCompletedFilter,
				},
				{ $set: { status: 'in_review', active_workflow_id: workflowId } },
				{ session },
			);
			if (locked.modifiedCount !== versionIds.length) {
				throw new WorkflowConflictError('A Product changed or is already in review. Reload and try again.');
			}

			await events.insertOne({
				workspaceId: context.workspaceId,
				workflowId,
				type: 'started',
				actorSnapshot: actor,
				data: { productCount: updated.products.length, assignmentCount: updated.assignments.length },
				createdAt: now,
			}, { session });

			await recordAuditEvent({
				workspaceId: context.workspaceId.toString(),
				scope: { type: 'workflow', id: workflowId.toString() },
				entity: { type: 'workflow', id: workflowId.toString() },
				action: 'update',
				eventKey: 'workflow.started',
				visibility: 'all',
				where: { module: 'workflows' },
				auth: auth.payload,
				changes: [{ path: 'status', from: 'draft', to: 'in_review' }],
				meta: { workflowNumber: workflow.numberLabel, workflowName: workflow.name },
				occurredAt: now,
				session,
			});

			return updated;
		});

		const { approvers, owners } = await getWorkflowParticipants(db, started);
		const approverKeys = new Set(approvers.map((id) => id.toString()));
		await Promise.all([
			notifyWorkflow({
				workflow: started,
				actorId: context.userId,
				recipients: approvers,
				type: 'workflow.approval_requested',
				title: `${actor.name} asked you to approve ${started.numberLabel}`,
				body: `"${started.name}" is ready for your review.`,
				tab: 'approvals',
			}),
			notifyWorkflow({
				workflow: started,
				actorId: context.userId,
				recipients: owners.filter((id) => !approverKeys.has(id.toString())),
				type: 'workflow.product_in_review',
				title: `${actor.name} started ${started.numberLabel}`,
				body: `Your Products in "${started.name}" are now In Review. Approvers are notified of any change you save.`,
			}),
		]);

		return ResponseWrapper.success({ message: 'Workflow started successfully', workflow: started });
	} catch (err) {
		if (err instanceof WorkflowConflictError) return ResponseWrapper.conflict(err.message);
		logError('Start workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to start workflow');
	}
};
