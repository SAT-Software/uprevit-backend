import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import { ClientSession, Db, ObjectId } from 'mongodb';
import type { NotificationType } from '../models/notification';
import type { Product } from '../models/product';
import type { User } from '../models/user';
import {
	ACTIVE_WORKFLOW_STATUSES,
	WORKFLOWS_COLLECTION,
	type Workflow,
	type WorkflowActorSnapshot,
} from '../models/workflow';
import { WORKFLOW_DISCUSSION_COLLECTION, type WorkflowDiscussionItem } from '../models/workflowDiscussion';
import { WORKFLOW_EVENTS_COLLECTION, type WorkflowEvent } from '../models/workflowEvent';
import { recordAuditEvent } from './auditLogV2';
import { withTransaction } from './db';
import { logError } from './logger';
import { notify, type NotifyInput } from './notifications';
import { releaseVersions } from './productLifecycle';

export const WORKFLOW_REASON_MAX_LENGTH = 1000;

/** Thrown inside a transaction when the workflow or its Products changed after they were read; maps to 409. */
export class WorkflowConflictError extends Error {}

let hasEnsuredEventIndexes = false;

export const workflowEvents = async (db: Db) => {
	const collection = db.collection<WorkflowEvent>(WORKFLOW_EVENTS_COLLECTION);
	if (!hasEnsuredEventIndexes) {
		await collection.createIndex({ workspaceId: 1, workflowId: 1, createdAt: -1 });
		hasEnsuredEventIndexes = true;
	}
	return collection;
};

/**
 * Snapshots the caller's name and email so later account changes cannot rewrite workflow history.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace id
 * @param {ObjectId} userId Caller id
 * @return {Promise<WorkflowActorSnapshot | null>} The snapshot, or null when the caller is not an active member
 */
export const getActorSnapshot = async (db: Db, workspaceId: ObjectId, userId: ObjectId): Promise<WorkflowActorSnapshot | null> => {
	const user = await db.collection<User>('users').findOne(
		{ _id: userId, workspaceId, status: 'active' },
		{ projection: { name: 1, email: 1 } },
	);
	return user ? { userId, name: user.name, email: user.email } : null;
};

/**
 * Parses an optional comment or a required reason from a request body.
 * @param {unknown} value Raw value
 * @param {Object} options Field label and whether it is required
 * @return {Object} The trimmed text (undefined when empty and optional), or an error message
 */
export const parseWorkflowText = (value: unknown, { label, required }: { label: string; required: boolean }) => {
	if (value !== undefined && value !== null && typeof value !== 'string') return { error: `${label} must be text` };
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) return required ? { error: `${label} is required` } : { value: undefined };
	if (text.length > WORKFLOW_REASON_MAX_LENGTH) return { error: `${label} must be at most ${WORKFLOW_REASON_MAX_LENGTH} characters` };
	return { value: text };
};

/**
 * Reads each included version's content revision, the checkpoint an approval was given against.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @param {ClientSession} session Optional transaction session
 * @return {Promise<Record<string, number>>} Content revision keyed by lineage id
 */
export const getContentCheckpoint = async (db: Db, workflow: Workflow, session?: ClientSession) => {
	const versions = await db.collection<Product>('products').find(
		{ _id: { $in: workflow.products.map((product) => product.productVersionId) }, workspace_id: workflow.workspaceId },
		{ projection: { content_revision: 1 }, session },
	).toArray();
	const revisions = new Map(versions.map((version) => [version._id!.toString(), version.content_revision ?? 0]));
	return Object.fromEntries(workflow.products.map((product) => [
		product.lineageId.toString(),
		revisions.get(product.productVersionId.toString()) ?? 0,
	]));
};

/**
 * Whether any Product's content changed after the given Content Checkpoint.
 * @param {Record<string, number>} checkpoint Checkpoint stored with a decision
 * @param {Record<string, number>} current Current checkpoint from `getContentCheckpoint`
 * @return {boolean} True when a Product's revision differs from the checkpoint
 */
export const contentChangedSince = (checkpoint: Record<string, number>, current: Record<string, number>) =>
	Object.entries(current).some(([lineageId, revision]) => (checkpoint[lineageId] ?? 0) !== revision);

/**
 * Adds `contentChangedSinceDecision` to each assignment: true when an active workflow's content changed after
 * the assignment's approval.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @return {Promise<Array>} Assignments with the flag
 */
export const withContentChangeFlags = async (db: Db, workflow: Workflow) => {
	const isActive = ACTIVE_WORKFLOW_STATUSES.includes(workflow.status);
	const current = isActive ? await getContentCheckpoint(db, workflow) : {};
	return workflow.assignments.map((assignment) => ({
		...assignment,
		contentChangedSinceDecision: isActive && !!assignment.contentCheckpoint && contentChangedSince(assignment.contentCheckpoint, current),
	}));
};

/**
 * Counts open change requests, for the whole workflow or for one assignment.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @param {Object} options Optional assignment and transaction session
 * @return {Promise<number>} Number of open change requests
 */
export const countOpenChangeRequests = (
	db: Db,
	workflow: Pick<Workflow, '_id' | 'workspaceId'>,
	{ assignmentId, session }: { assignmentId?: ObjectId; session?: ClientSession } = {},
) => db.collection<WorkflowDiscussionItem>(WORKFLOW_DISCUSSION_COLLECTION).countDocuments({
	workspaceId: workflow.workspaceId,
	workflowId: workflow._id!,
	kind: 'change_request',
	status: 'open',
	...(assignmentId && { assignmentId }),
}, { session });

/**
 * Finds everyone involved in a workflow: the Initiator, every approver, and each Product's owner.
 * Runs after the lifecycle change has committed, so a failed owner lookup is logged and only skips the owners.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @return {Promise<Object>} Approver ids and Product owner ids, with the Initiator in `all`
 */
export const getWorkflowParticipants = async (db: Db, workflow: Workflow) => {
	const lineageIds = workflow.products.map((product) => product.lineageId);
	const latest = await db.collection<Product>('products').find({
		workspace_id: workflow.workspaceId,
		is_latest: true,
		$or: [{ product_lineage_id: { $in: lineageIds } }, { _id: { $in: lineageIds }, product_lineage_id: { $exists: false } }],
	}, { projection: { owner_user_id: 1 } }).toArray().catch((err) => {
		logError('Workflow participant lookup failed', err, { workflowId: workflow._id?.toString() });
		return [];
	});
	const approvers = workflow.assignments.map((assignment) => assignment.userId);
	const owners = latest.map((product) => product.owner_user_id).filter((id): id is ObjectId => !!id);
	return { approvers, owners, all: [workflow.initiator.userId, ...approvers, ...owners] };
};

type WorkflowTab = 'approvals' | 'discussion' | 'history';

export const workflowLink = (workflow: Workflow, tab?: WorkflowTab) =>
	`/workflows/${workflow._id!.toString()}${tab ? `?tab=${tab}` : ''}`;

const excluding = (ids: ObjectId[], actorId: ObjectId) => ids.filter((id) => !id.equals(actorId));

export type WorkflowNotificationInput = {
	workflow: Workflow;
	actorId: ObjectId;
	recipients: ObjectId[];
	type: NotificationType;
	title: string;
	body?: string;
	tab?: WorkflowTab;
};

/**
 * Builds a workflow notification for every recipient except the person who acted.
 * @param {WorkflowNotificationInput} input Workflow, actor, recipients and content
 * @return {NotifyInput} Notification input linking to the workflow
 */
export const workflowNotification = ({ workflow, actorId, recipients, type, title, body, tab }: WorkflowNotificationInput): NotifyInput => ({
	workspaceId: workflow.workspaceId,
	recipients: excluding(recipients, actorId),
	type,
	title,
	body,
	link: workflowLink(workflow, tab),
	meta: { workflowId: workflow._id!.toString(), workflowNumber: workflow.numberLabel, actorUserId: actorId.toString() },
});

/**
 * Sends one notification to every recipient except the person who acted.
 * @param {WorkflowNotificationInput} input Workflow, actor, recipients and content
 * @return {Promise<void>} Resolves once notifications are attempted
 */
export const notifyWorkflow = (input: WorkflowNotificationInput) => notify(workflowNotification(input));

type EndWorkflowInput = {
	db: Db;
	workflow: Workflow;
	outcome: 'rejected' | 'cancelled';
	actor: WorkflowActorSnapshot;
	reason: string;
	auth: Partial<CognitoAccessTokenPayload>;
	/** The pending assignment whose rejection ends the workflow. */
	rejection?: { assignmentId: ObjectId };
};

/**
 * Ends a started workflow without releasing anything, used by both Reject and Cancel. In one transaction it
 * records the rejecting decision (if any), sets the workflow status and date, returns every version to Submitted,
 * and writes the history and audit events. Then it notifies all participants.
 * Throws `WorkflowConflictError` when the workflow is no longer active or the assignment was already decided.
 * @param {EndWorkflowInput} input Workflow, outcome, actor and reason
 * @return {Promise<Workflow>} The ended workflow
 */
export const endWorkflowWithoutRelease = async ({ db, workflow, outcome, actor, reason, auth, rejection }: EndWorkflowInput) => {
	const now = new Date();
	const workflowId = workflow._id!;
	const assignment = rejection && workflow.assignments.find((item) => item._id.equals(rejection.assignmentId));
	const events = await workflowEvents(db);

	const ended = await withTransaction(async (txDb, session) => {
		const contentCheckpoint = assignment ? await getContentCheckpoint(txDb, workflow, session) : undefined;
		const updated = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
			{
				_id: workflowId,
				workspaceId: workflow.workspaceId,
				status: { $in: outcome === 'rejected' ? ['in_review'] : ACTIVE_WORKFLOW_STATUSES },
				...(assignment && {
					assignments: { $elemMatch: { _id: assignment._id, userId: actor.userId, decision: { $in: ['pending', 'changes_requested'] } } },
				}),
			},
			{
				$set: {
					status: outcome,
					[`dates.${outcome}At`]: now,
					endReason: reason,
					endedBy: actor,
					...(assignment && {
						'assignments.$.decision': 'rejected',
						'assignments.$.decidedAt': now,
						'assignments.$.reason': reason,
						'assignments.$.contentCheckpoint': contentCheckpoint,
					}),
				},
			},
			{ returnDocument: 'after', session },
		);
		if (!updated) throw new WorkflowConflictError('This workflow has already ended or changed. Reload and try again.');

		await txDb.collection<Product>('products').updateMany(
			{
				_id: { $in: workflow.products.map((product) => product.productVersionId) },
				workspace_id: workflow.workspaceId,
				active_workflow_id: workflowId,
				status: 'in_review',
			},
			{ $set: { status: 'submitted' }, $unset: { active_workflow_id: '' } },
			{ session },
		);

		await events.insertOne({
			workspaceId: workflow.workspaceId,
			workflowId,
			type: outcome,
			actorSnapshot: actor,
			...(assignment && { assignmentId: assignment._id, lineageId: assignment.lineageId }),
			reason,
			data: assignment ? { functionLabel: assignment.functionLabel, contentCheckpoint } : {},
			createdAt: now,
		}, { session });

		await recordAuditEvent({
			workspaceId: workflow.workspaceId.toString(),
			scope: { type: 'workflow', id: workflowId.toString() },
			entity: { type: 'workflow', id: workflowId.toString() },
			action: 'update',
			eventKey: `workflow.${outcome}`,
			visibility: 'all',
			where: { module: 'workflows' },
			auth,
			changes: [{ path: 'status', from: workflow.status, to: outcome }],
			meta: { workflowNumber: workflow.numberLabel, workflowName: workflow.name, reason },
			occurredAt: now,
			session,
		});

		return updated;
	});

	const { all } = await getWorkflowParticipants(db, workflow);
	await notifyWorkflow({
		workflow,
		actorId: actor.userId,
		recipients: all,
		type: outcome === 'rejected' ? 'workflow.rejected' : 'workflow.cancelled',
		title: `${actor.name} ${outcome} ${workflow.numberLabel}`,
		body: `"${workflow.name}" ended without release, and its Products are back to Submitted. Reason: ${reason}`,
		tab: 'history',
	});

	return ended;
};

type CompletionInput = {
	db: Db;
	session: ClientSession;
	workflow: Workflow;
	actor: WorkflowActorSnapshot;
	auth: Partial<CognitoAccessTokenPayload>;
};

/**
 * Completes a workflow inside the caller's transaction: every version becomes Released, each Product's previous
 * release becomes Obsolete, and the workflow becomes Completed. Throws `WorkflowConflictError` if anything changed.
 * @param {CompletionInput} input Workflow, actor and the transaction to join
 * @return {Promise<Workflow>} The completed workflow
 */
export const completeWorkflow = async ({ db, session, workflow, actor, auth }: CompletionInput) => {
	const now = new Date();
	const workflowId = workflow._id!;
	const completed = await db.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
		{ _id: workflowId, workspaceId: workflow.workspaceId, status: workflow.status },
		{ $set: { 'status': 'completed', 'dates.completedAt': now } },
		{ returnDocument: 'after', session },
	);
	if (!completed) throw new WorkflowConflictError('This workflow has already ended or changed. Reload and try again.');

	const versions = await db.collection<Product>('products').find(
		{
			_id: { $in: workflow.products.map((product) => product.productVersionId) },
			workspace_id: workflow.workspaceId,
			status: 'in_review',
			active_workflow_id: workflowId,
		},
		{ projection: { workspace_id: 1, product_lineage_id: 1, product_name: 1 }, session },
	).toArray();
	if (versions.length !== workflow.products.length) {
		throw new WorkflowConflictError('A Product in this workflow changed. Reload and try again.');
	}
	await releaseVersions(db, versions, { workflowId, session });

	await db.collection<WorkflowEvent>(WORKFLOW_EVENTS_COLLECTION).insertOne({
		workspaceId: workflow.workspaceId,
		workflowId,
		type: 'completed',
		actorSnapshot: actor,
		data: { productCount: versions.length, automatic: workflow.status === 'in_review' },
		createdAt: now,
	}, { session });

	const meta = { workflowNumber: workflow.numberLabel, workflowName: workflow.name };
	await recordAuditEvent({
		workspaceId: workflow.workspaceId.toString(),
		scope: { type: 'workflow', id: workflowId.toString() },
		entity: { type: 'workflow', id: workflowId.toString() },
		action: 'update',
		eventKey: 'workflow.completed',
		visibility: 'all',
		where: { module: 'workflows' },
		auth,
		changes: [{ path: 'status', from: workflow.status, to: 'completed' }],
		meta,
		occurredAt: now,
		session,
	});
	for (const version of versions) {
		await recordAuditEvent({
			workspaceId: workflow.workspaceId.toString(),
			scope: { type: 'product', id: version._id!.toString() },
			entity: { type: 'product', id: version._id!.toString() },
			action: 'update',
			eventKey: 'product.released_by_workflow',
			visibility: 'all',
			where: { module: 'products' },
			auth,
			changes: [{ path: 'status', from: 'in_review', to: 'released' }],
			meta: { ...meta, productName: version.product_name },
			occurredAt: now,
			session,
		});
	}

	return completed;
};

/**
 * Runs after every approval inside the same transaction. Once every assignment has approved and no change request is
 * open, an Automatic workflow completes right away and an Initiator-controlled one moves to Ready to Complete.
 * @param {CompletionInput} input Workflow (as just approved), actor and the transaction to join
 * @return {Promise<Workflow>} The workflow, unchanged while approvals are still pending
 */
export const evaluateCompletion = async (input: CompletionInput) => {
	const { db, session, workflow, actor } = input;
	if (workflow.status !== 'in_review' || workflow.assignments.some((assignment) => assignment.decision !== 'approved')) {
		return workflow;
	}
	if (await countOpenChangeRequests(db, workflow, { session }) > 0) return workflow;
	if (workflow.completionMode === 'automatic') return completeWorkflow(input);

	const now = new Date();
	const ready = await db.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
		{ _id: workflow._id, workspaceId: workflow.workspaceId, status: 'in_review' },
		{ $set: { 'status': 'ready_to_complete', 'dates.readyToCompleteAt': now } },
		{ returnDocument: 'after', session },
	);
	if (!ready) throw new WorkflowConflictError('This workflow has already ended or changed. Reload and try again.');

	await db.collection<WorkflowEvent>(WORKFLOW_EVENTS_COLLECTION).insertOne({
		workspaceId: workflow.workspaceId,
		workflowId: workflow._id!,
		type: 'ready_to_complete',
		actorSnapshot: actor,
		data: {},
		createdAt: now,
	}, { session });

	return ready;
};

/**
 * Tells the Initiator about each approval while others are still pending; the final approval instead triggers the
 * completed or ready-to-complete notification.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow after the approval committed
 * @param {WorkflowActorSnapshot} actor Approver
 * @param {string} functionLabel Function the approver approved as
 * @return {Promise<void>} Resolves once notifications are attempted
 */
export const notifyApproval = (db: Db, workflow: Workflow, actor: WorkflowActorSnapshot, functionLabel: string) => {
	if (workflow.status !== 'in_review') return notifyCompletion(db, workflow, actor);
	const approved = workflow.assignments.filter((assignment) => assignment.decision === 'approved').length;
	return notifyWorkflow({
		workflow,
		actorId: actor.userId,
		recipients: [workflow.initiator.userId],
		type: 'workflow.approved',
		title: `${actor.name} approved ${workflow.numberLabel}`,
		body: `Approved as ${functionLabel}. ${approved} of ${workflow.assignments.length} approvals are in for "${workflow.name}".`,
		tab: 'approvals',
	});
};

/**
 * Tells everyone once a workflow completes, or tells the Initiator once it is ready to complete.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow after the change committed
 * @param {WorkflowActorSnapshot} actor Person whose action caused the change
 * @return {Promise<void>} Resolves once notifications are attempted
 */
export const notifyCompletion = async (db: Db, workflow: Workflow, actor: WorkflowActorSnapshot) => {
	if (workflow.status === 'ready_to_complete') {
		return notifyWorkflow({
			workflow,
			actorId: actor.userId,
			recipients: [workflow.initiator.userId],
			type: 'workflow.ready_to_complete',
			title: `${workflow.numberLabel} is ready to complete`,
			body: `Everyone approved "${workflow.name}". Complete it to release its Products.`,
		});
	}
	if (workflow.status !== 'completed') return;
	const { all } = await getWorkflowParticipants(db, workflow);
	return notifyWorkflow({
		workflow,
		actorId: actor.userId,
		recipients: all,
		type: 'workflow.completed',
		title: `${workflow.numberLabel} completed`,
		body: `"${workflow.name}" is complete, and its Products are now Released.`,
		tab: 'history',
	});
};
