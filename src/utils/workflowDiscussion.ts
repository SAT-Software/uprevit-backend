import { ClientSession, Db, ObjectId } from 'mongodb';
import type { Product } from '../models/product';
import {
	ACTIVE_WORKFLOW_STATUSES,
	WORKFLOWS_COLLECTION,
	type Workflow,
	type WorkflowActorSnapshot,
	type WorkflowAssignment,
} from '../models/workflow';
import {
	WORKFLOW_ATTACHMENT_CONTENT_TYPES,
	WORKFLOW_ATTACHMENT_LIMIT,
	WORKFLOW_ATTACHMENT_MAX_BYTES,
	WORKFLOW_DISCUSSION_COLLECTION,
	type WorkflowDiscussionAttachment,
	type WorkflowDiscussionItem,
	type WorkflowDiscussionScope,
} from '../models/workflowDiscussion';
import { recordCommittedUploadBytes } from './billing/uploadCommit';
import { withTransaction } from './db';
import { logError } from './logger';
import { createPresignedGetUrlMap, headUploadObject, workflowAttachmentKeyPrefix } from './s3-storage';
import type { TenantContext } from './tenantContext';
import { WorkflowConflictError, assertCanDecide, notifyWorkflow, workflowEvents } from './workflowLifecycle';
import { canManageWorkflow, lineageIdOf } from './workflows';

let hasEnsuredDiscussionIndexes = false;

export const workflowDiscussion = async (db: Db) => {
	const collection = db.collection<WorkflowDiscussionItem>(WORKFLOW_DISCUSSION_COLLECTION);
	if (!hasEnsuredDiscussionIndexes) {
		await collection.createIndex({ workspaceId: 1, workflowId: 1, createdAt: 1 });
		hasEnsuredDiscussionIndexes = true;
	}
	return collection;
};

/**
 * Parses a discussion scope: the whole workflow, or one of the workflow's Products.
 * @param {unknown} value Raw `scope` from the request body
 * @param {Workflow} workflow Workflow the scope must belong to
 * @return {Object} The scope, or an error message
 */
export const parseDiscussionScope = (value: unknown, workflow: Workflow): { value: WorkflowDiscussionScope } | { error: string } => {
	const scope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	if (scope.type === 'package') return { value: { type: 'package' } };
	if (scope.type !== 'product') return { error: 'scope.type must be one of: package, product' };
	const lineageId = typeof scope.lineageId === 'string' && ObjectId.isValid(scope.lineageId) ? new ObjectId(scope.lineageId) : null;
	const product = lineageId && workflow.products.find((item) => item.lineageId.equals(lineageId));
	if (!product) return { error: 'scope.lineageId must be a Product in this workflow' };
	return { value: { type: 'product', lineageId: product.lineageId } };
};

/**
 * Checks attachment keys against images the caller uploaded to this workflow, reading each stored object's real type
 * and size.
 * @param {unknown} value Raw `attachments` from the request body: an array of upload keys
 * @param {Workflow} workflow Workflow the images were uploaded to
 * @param {ObjectId} userId Caller, who must have uploaded every image
 * @return {Promise<Object>} The attachments, or an error message
 */
export const parseDiscussionAttachments = async (
	value: unknown,
	workflow: Workflow,
	userId: ObjectId,
): Promise<{ value: WorkflowDiscussionAttachment[] } | { error: string }> => {
	if (value === undefined || value === null) return { value: [] };
	if (!Array.isArray(value) || value.some((key) => typeof key !== 'string')) return { error: 'attachments must be a list of upload keys' };
	const keys = [...new Set(value as string[])];
	if (keys.length > WORKFLOW_ATTACHMENT_LIMIT) return { error: `You can attach up to ${WORKFLOW_ATTACHMENT_LIMIT} images` };
	const prefix = workflowAttachmentKeyPrefix(workflow.workspaceId.toString(), workflow._id!.toString(), userId.toString());
	if (keys.some((key) => !key.startsWith(prefix) || key.slice(prefix.length).includes('/'))) {
		return { error: 'Attachments must be images you uploaded to this workflow' };
	}
	const objects = await Promise.all(keys.map(headUploadObject));
	const attachments: WorkflowDiscussionAttachment[] = [];
	for (const [index, key] of keys.entries()) {
		const object = objects[index];
		if (!object) return { error: 'An attached image was not uploaded. Remove it and try again.' };
		if (!WORKFLOW_ATTACHMENT_CONTENT_TYPES.includes(object.contentType)) return { error: 'Attachments must be PNG, JPEG, WebP or GIF images' };
		if (object.sizeBytes > WORKFLOW_ATTACHMENT_MAX_BYTES) return { error: 'Each image must be 10 MB or smaller' };
		attachments.push({ key, fileName: key.slice(prefix.length + 37), contentType: object.contentType, sizeBytes: object.sizeBytes });
	}
	return { value: attachments };
};

/**
 * Records the upload volume of attachments that were just saved. Failures are logged, not thrown.
 * @param {ObjectId} workspaceId Workspace
 * @param {WorkflowDiscussionAttachment[]} attachments Saved attachments
 * @return {Promise<void>} Resolves when recorded
 */
export const recordAttachmentUploads = (workspaceId: ObjectId, attachments: WorkflowDiscussionAttachment[]) =>
	Promise.all(attachments.map(({ key, sizeBytes }) => recordCommittedUploadBytes({ workspaceId, uploadKey: key, sizeBytes })))
		.catch((err) => logError('Workflow attachment usage recording failed', err, { workspaceId: workspaceId.toString() }));

/**
 * Adds a short-lived view `url` to every attachment.
 * @param {WorkflowDiscussionItem[]} items Discussion items
 * @param {ObjectId} workspaceId Workspace the attachments belong to
 * @return {Promise<WorkflowDiscussionItem[]>} Items with signed attachment URLs
 */
export const withAttachmentUrls = async (items: WorkflowDiscussionItem[], workspaceId: ObjectId) => {
	const urls = await createPresignedGetUrlMap(items.flatMap((item) => item.attachments?.map(({ key }) => key) ?? []), { workspaceId });
	return items.map((item) => item.attachments?.length
		? { ...item, attachments: item.attachments.map((attachment) => ({ ...attachment, url: urls.get(attachment.key) })) }
		: item);
};

export const scopeLabel = (workflow: Workflow, scope: WorkflowDiscussionScope) =>
	scope.type === 'package'
		? 'the whole workflow'
		: `"${workflow.products.find((product) => product.lineageId.equals(scope.lineageId))?.name ?? 'a Product'}"`;

/**
 * Finds the owner and contributors of each Product's latest version, keyed by lineage id.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @return {Promise<Map<string, ObjectId[]>>} Owner and contributor ids for each Product
 */
export const getProductTeamIds = async (db: Db, workflow: Workflow) => {
	const lineageIds = workflow.products.map((product) => product.lineageId);
	const teams = new Map<string, ObjectId[]>();
	if (lineageIds.length === 0) return teams;
	const latest = await db.collection<Product>('products').find({
		workspace_id: workflow.workspaceId,
		is_latest: true,
		$or: [{ product_lineage_id: { $in: lineageIds } }, { _id: { $in: lineageIds }, product_lineage_id: { $exists: false } }],
	}, { projection: { product_lineage_id: 1, owner_user_id: 1, contributor_user_ids: 1 } }).toArray();
	for (const product of latest) {
		const ids = [product.owner_user_id, ...(product.contributor_user_ids ?? [])].filter((id): id is ObjectId => !!id);
		teams.set(lineageIdOf(product).toString(), ids);
	}
	return teams;
};

/** The people who can address a request in this scope: one Product's team, or every Product's team for the whole workflow. */
export const scopeTeamIds = (teams: Map<string, ObjectId[]>, scope: WorkflowDiscussionScope) =>
	scope.type === 'product' ? teams.get(scope.lineageId.toString()) ?? [] : [...teams.values()].flat();

/** Whether the caller may mark a request addressed: the Initiator, or an owner or contributor of a Product in its scope. */
export const canAddressRequest = (userId: ObjectId, workflow: Workflow, teams: Map<string, ObjectId[]>, scope: WorkflowDiscussionScope) =>
	workflow.initiator.userId.equals(userId) || scopeTeamIds(teams, scope).some((id) => id.equals(userId));

/**
 * Whether the caller may comment: the Initiator, an admin, an assigned approver, or a member of an included Product's team.
 * @param {Object} user Caller
 * @param {Workflow} workflow Workflow
 * @param {Map<string, ObjectId[]>} teams Product teams from `getProductTeamIds`
 * @return {boolean} True when the caller may comment
 */
export const canComment = (user: Pick<TenantContext, 'userId' | 'cognitoGroups'>, workflow: Workflow, teams: Map<string, ObjectId[]>) =>
	canManageWorkflow(user, workflow)
	|| workflow.assignments.some((assignment) => assignment.userId.equals(user.userId))
	|| scopeTeamIds(teams, { type: 'package' }).some((id) => id.equals(user.userId));

/**
 * Inside a discussion transaction, conditionally writes the workflow so a concurrent Reject, Cancel or Complete conflicts
 * with the discussion change instead of racing it. Throws `WorkflowConflictError` when the workflow is no longer active.
 * @param {Db} db Transaction database handle
 * @param {Workflow} workflow Workflow
 * @param {ClientSession} session Transaction session
 * @param {Date} now Time of the discussion change
 * @return {Promise<void>} Resolves when the workflow is still active
 */
export const lockActiveWorkflow = async (db: Db, workflow: Workflow, session: ClientSession, now: Date) => {
	const locked = await db.collection<Workflow>(WORKFLOWS_COLLECTION).updateOne(
		{ _id: workflow._id, workspaceId: workflow.workspaceId, status: { $in: ACTIVE_WORKFLOW_STATUSES } },
		{ $set: { discussionUpdatedAt: now } },
		{ session },
	);
	if (locked.matchedCount === 0) throw new WorkflowConflictError('This workflow has already ended');
};

type RequestChangesInput = {
	db: Db;
	workflow: Workflow;
	assignment: WorkflowAssignment;
	actor: WorkflowActorSnapshot;
	scope: WorkflowDiscussionScope;
	reason: string;
	attachments: WorkflowDiscussionAttachment[];
};

/**
 * Records a change request: the assignment becomes Changes Requested (an earlier approval stops counting), the request
 * is added to the discussion, and a Ready to Complete workflow goes back to In Review. Then it notifies the scoped
 * Product Team and the Initiator.
 * @param {RequestChangesInput} input Workflow, the requester's assignment, scope and reason
 * @return {Promise<Workflow>} The updated workflow
 */
export const requestChanges = async ({ db, workflow, assignment, actor, scope, reason, attachments }: RequestChangesInput) => {
	const now = new Date();
	const workflowId = workflow._id!;
	const [discussion, events] = await Promise.all([workflowDiscussion(db), workflowEvents(db)]);

	const updated = await withTransaction(async (txDb, session) => {
		await assertCanDecide(txDb, workflow.workspaceId, assignment, session);
		const result = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
			{
				_id: workflowId,
				workspaceId: workflow.workspaceId,
				status: { $in: ACTIVE_WORKFLOW_STATUSES },
				assignments: { $elemMatch: { _id: assignment._id, userId: actor.userId, decision: { $ne: 'rejected' }, needsReplacement: { $exists: false } } },
			},
			{
				$set: {
					'status': 'in_review',
					'assignments.$.decision': 'changes_requested',
					'assignments.$.decidedAt': now,
					'assignments.$.changeNoticeSent': false,
				},
				$unset: { 'dates.readyToCompleteAt': '', 'assignments.$.comment': '', 'assignments.$.contentCheckpoint': '' },
			},
			{ returnDocument: 'before', session },
		);
		if (!result) throw new WorkflowConflictError('This workflow or assignment changed. Reload and try again.');
		const previousDecision = result.assignments.find((item) => item._id.equals(assignment._id))?.decision;

		const { insertedId } = await discussion.insertOne({
			workspaceId: workflow.workspaceId,
			workflowId,
			kind: 'change_request',
			scope,
			authorSnapshot: actor,
			body: reason,
			...(attachments.length > 0 && { attachments }),
			createdAt: now,
			assignmentId: assignment._id,
			status: 'open',
		}, { session });

		await events.insertOne({
			workspaceId: workflow.workspaceId,
			workflowId,
			type: 'changes_requested',
			actorSnapshot: actor,
			assignmentId: assignment._id,
			...(scope.type === 'product' && { lineageId: scope.lineageId }),
			reason,
			data: {
				functionLabel: assignment.functionLabel,
				discussionItemId: insertedId,
				previousDecision,
				reopened: result.status === 'ready_to_complete',
			},
			createdAt: now,
		}, { session });

		return txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOne({ _id: workflowId }, { session });
	});

	await recordAttachmentUploads(workflow.workspaceId, attachments);
	const team = await getProductTeamIds(db, workflow).then((teams) => scopeTeamIds(teams, scope)).catch((err) => {
		logError('Change request team lookup failed', err, { workflowId: workflowId.toString() });
		return [];
	});
	await notifyWorkflow({
		workflow,
		actorId: actor.userId,
		recipients: [workflow.initiator.userId, ...team],
		type: 'workflow.changes_requested',
		title: `${actor.name} requested changes on ${workflow.numberLabel}`,
		body: `On ${scopeLabel(workflow, scope)}: ${reason}`,
		tab: 'discussion',
	});

	return updated!;
};
