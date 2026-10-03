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
import { WORKFLOW_EVENTS_COLLECTION, type WorkflowEvent } from '../models/workflowEvent';
import { recordAuditEvent } from './auditLogV2';
import { withTransaction } from './db';
import { logError } from './logger';
import { notify } from './notifications';

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

export const workflowLink = (workflow: Workflow, tab?: 'approvals' | 'history') =>
	`/workflows/${workflow._id!.toString()}${tab ? `?tab=${tab}` : ''}`;

const excluding = (ids: ObjectId[], actorId: ObjectId) => ids.filter((id) => !id.equals(actorId));

/**
 * Sends one notification to every recipient except the person who acted.
 * @param {Object} input Workflow, actor, recipients and content
 * @return {Promise<void>} Resolves once notifications are attempted
 */
export const notifyWorkflow = ({ workflow, actorId, recipients, type, title, body, tab }: {
	workflow: Workflow;
	actorId: ObjectId;
	recipients: ObjectId[];
	type: NotificationType;
	title: string;
	body?: string;
	tab?: 'approvals' | 'history';
}) => notify({
	workspaceId: workflow.workspaceId,
	recipients: excluding(recipients, actorId),
	type,
	title,
	body,
	link: workflowLink(workflow, tab),
	meta: { workflowId: workflow._id!.toString(), workflowNumber: workflow.numberLabel, actorUserId: actorId.toString() },
});

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
				...(assignment && { assignments: { $elemMatch: { _id: assignment._id, userId: actor.userId, decision: 'pending' } } }),
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
