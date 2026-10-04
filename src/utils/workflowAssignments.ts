import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import { ClientSession, Db, ObjectId } from 'mongodb';
import type { Product } from '../models/product';
import type { User } from '../models/user';
import {
	UNDECIDED_DECISIONS,
	WORKFLOWS_COLLECTION,
	type ReplacedWorkflowAssignment,
	type Workflow,
	type WorkflowActorSnapshot,
	type WorkflowAssignment,
	type WorkflowUnavailableCause,
} from '../models/workflow';
import { WORKFLOW_DISCUSSION_COLLECTION, type WorkflowDiscussionItem } from '../models/workflowDiscussion';
import { recordAuditEvent } from './auditLogV2';
import { withTransaction } from './db';
import { logError } from './logger';
import { notify } from './notifications';
import { WorkflowConflictError, getActorSnapshot, notifyWorkflow, workflowEvents, workflowNotification } from './workflowLifecycle';
import { getProductTeam, getSoleApproverProblem, loadWorkflowProductState } from './workflows';

/** Thrown when the chosen replacement is not allowed; maps to 400. */
export class WorkflowReplacementError extends Error {}

const findLatestVersion = (db: Db, workspaceId: ObjectId, lineageId: ObjectId, session?: ClientSession) =>
	db.collection<Product>('products').findOne(
		{ workspace_id: workspaceId, is_latest: true, $or: [{ product_lineage_id: lineageId }, { _id: lineageId, product_lineage_id: { $exists: false } }] },
		{ projection: { owner_user_id: 1, contributor_user_ids: 1 }, session },
	);

const isSameGroup = (a: WorkflowAssignment, b: WorkflowAssignment) =>
	a.functionType === b.functionType && (a.functionType === 'product_team'
		? !!a.lineageId && !!b.lineageId && a.lineageId.equals(b.lineageId)
		: a.functionLabel.toLowerCase() === b.functionLabel.toLowerCase());

/**
 * Whether the person on an assignment may still act on it: anyone for a Function, and only a current owner or
 * contributor of the Product for Product Team.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace id
 * @param {WorkflowAssignment} assignment Assignment to check
 * @return {Promise<boolean>} True when the assigned person is still eligible
 */
export const isStillEligible = async (db: Db, workspaceId: ObjectId, assignment: WorkflowAssignment) => {
	if (assignment.functionType !== 'product_team' || !assignment.lineageId) return true;
	const latest = await findLatestVersion(db, workspaceId, assignment.lineageId);
	return !!latest && [latest.owner_user_id, ...(latest.contributor_user_ids ?? [])].some((id) => id?.equals(assignment.userId));
};

type ReplaceAssignmentInput = {
	db: Db;
	workflowId: ObjectId;
	workspaceId: ObjectId;
	assignmentId: ObjectId;
	userId: ObjectId;
	reason: string;
	actor: WorkflowActorSnapshot;
	auth: Partial<CognitoAccessTokenPayload>;
};

/**
 * Replaces an approver who has not decided yet. The old assignment moves to `replacedAssignments` and a new pending
 * assignment for the same Function takes its place; its open change requests move to the new approver. Records the
 * history and audit events, then notifies both people. Throws `WorkflowReplacementError` when the new person is not
 * eligible and `WorkflowConflictError` when the workflow or assignment changed.
 * @param {ReplaceAssignmentInput} input Workflow and assignment ids, the new person, reason and actor
 * @return {Promise<Workflow>} The updated workflow
 */
export const replaceAssignment = async ({ db, workflowId, workspaceId, assignmentId, userId, reason, actor, auth }: ReplaceAssignmentInput) => {
	const now = new Date();
	const events = await workflowEvents(db);

	const { updated, assignment, replacement } = await withTransaction(async (txDb, session) => {
		const workflow = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOne({ _id: workflowId, workspaceId }, { session });
		const assignment = workflow?.assignments.find((item) => item._id.equals(assignmentId));
		if (!workflow || !assignment || workflow.status !== 'in_review' || !UNDECIDED_DECISIONS.includes(assignment.decision)) {
			throw new WorkflowConflictError('This approver already decided or was replaced. Reload and try again.');
		}
		if (assignment.userId.equals(userId)) throw new WorkflowReplacementError('Pick someone other than the current approver');

		const member = await txDb.collection<User>('users').findOne(
			{ _id: userId, workspaceId, status: 'active' },
			{ projection: { name: 1, email: 1 }, session },
		);
		if (!member) throw new WorkflowReplacementError('The new approver must be an active member of this workspace');

		let relationship = assignment.relationship;
		if (assignment.functionType === 'product_team') {
			const latest = assignment.lineageId && await findLatestVersion(txDb, workflow.workspaceId, assignment.lineageId, session);
			const teamMember = latest && (await getProductTeam(txDb, workflow.workspaceId, latest)).find((item) => item._id.equals(userId));
			if (!teamMember) {
				const product = workflow.products.find((item) => item.lineageId.equals(assignment.lineageId!));
				throw new WorkflowReplacementError(`Only the Product Owner or Contributors of ${product?.name ?? 'this Product'} can approve for its Product Team`);
			}
			relationship = teamMember.relationship;
		}

		const replacement: WorkflowAssignment = {
			_id: new ObjectId(),
			functionType: assignment.functionType,
			functionLabel: assignment.functionLabel,
			...(assignment.lineageId && { lineageId: assignment.lineageId }),
			userId,
			userSnapshot: { name: member.name, email: member.email },
			...(relationship && { relationship }),
			decision: 'pending',
		};
		if (workflow.assignments.some((item) => !item._id.equals(assignment._id) && item.userId.equals(userId) && isSameGroup(item, replacement))) {
			throw new WorkflowReplacementError(`${member.name} is already assigned here`);
		}
		const assignments = workflow.assignments.map((item) => item._id.equals(assignment._id) ? replacement : item);
		const soleApproverProblem = getSoleApproverProblem({ ...workflow, assignments }, (await loadWorkflowProductState(txDb, workflow, session)).latest);
		if (soleApproverProblem) throw new WorkflowReplacementError(soleApproverProblem);

		const replaced: ReplacedWorkflowAssignment = {
			...assignment,
			replacedAt: now,
			replacedBy: actor,
			replacementReason: reason,
			replacementAssignmentId: replacement._id,
		};
		const updated = await txDb.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
			{
				_id: workflowId,
				workspaceId: workflow.workspaceId,
				status: 'in_review',
				assignments: { $elemMatch: { _id: assignment._id, userId: assignment.userId, decision: assignment.decision } },
			},
			{ $set: { 'assignments.$': replacement }, $push: { replacedAssignments: replaced } },
			{ returnDocument: 'after', session },
		);
		if (!updated) throw new WorkflowConflictError('This approver already decided or was replaced. Reload and try again.');

		await txDb.collection<WorkflowDiscussionItem>(WORKFLOW_DISCUSSION_COLLECTION).updateMany(
			{ workspaceId: workflow.workspaceId, workflowId, kind: 'change_request', status: 'open', assignmentId: assignment._id },
			{ $set: { assignmentId: replacement._id } },
			{ session },
		);

		await events.insertOne({
			workspaceId: workflow.workspaceId,
			workflowId,
			type: 'approver_replaced',
			actorSnapshot: actor,
			assignmentId: replacement._id,
			...(assignment.lineageId && { lineageId: assignment.lineageId }),
			reason,
			data: {
				functionLabel: assignment.functionLabel,
				previousAssignmentId: assignment._id,
				previousDecision: assignment.decision,
				from: { userId: assignment.userId, ...assignment.userSnapshot },
				to: { userId, ...replacement.userSnapshot },
			},
			createdAt: now,
		}, { session });

		await recordAuditEvent({
			workspaceId: workflow.workspaceId.toString(),
			scope: { type: 'workflow', id: workflowId.toString() },
			entity: { type: 'workflow', id: workflowId.toString() },
			action: 'update',
			eventKey: 'workflow.approver_replaced',
			visibility: 'all',
			where: { module: 'workflows' },
			auth,
			changes: [{ path: 'assignments.userId', from: assignment.userSnapshot.name, to: replacement.userSnapshot.name }],
			meta: { workflowNumber: workflow.numberLabel, workflowName: workflow.name, functionLabel: assignment.functionLabel, reason },
			occurredAt: now,
			session,
		});

		return { updated, assignment, replacement };
	});

	await Promise.all([
		notifyWorkflow({
			workflow: updated,
			actorId: actor.userId,
			recipients: [userId],
			type: 'workflow.approval_requested',
			title: `${actor.name} asked you to approve ${updated.numberLabel}`,
			body: `You now approve as ${replacement.functionLabel} instead of ${assignment.userSnapshot.name} on "${updated.name}".`,
			tab: 'approvals',
		}),
		notifyWorkflow({
			workflow: updated,
			actorId: actor.userId,
			recipients: [assignment.userId],
			type: 'workflow.approver_replaced',
			title: `${actor.name} replaced you on ${updated.numberLabel}`,
			body: `${replacement.userSnapshot.name} now approves as ${replacement.functionLabel} instead of you. Reason: ${reason}`,
			tab: 'history',
		}),
	]);

	return updated;
};

type FlagUnavailableInput = { db: Db; workspaceId: ObjectId; actorId: ObjectId } & (
	| { userId: ObjectId; lineageId?: never }
	| { lineageId: ObjectId; userId?: never }
);

/**
 * Flags undecided assignments whose approver can no longer act, so the Initiator can replace them; nothing is removed.
 * With `userId`, every undecided assignment of a member who left the workspace is flagged. With `lineageId`, the
 * Product Team assignments of that Product are re-checked against its current owner and contributors, and a Product
 * Team flag is cleared when the person is back on the team; a workspace-removal flag is never cleared. Each workflow
 * is reconciled in its own transaction that first writes the workflow, so concurrent reconciliations retry on current
 * state. Newly flagged assignments are recorded in History and the Initiator is notified. Never throws: a failure is
 * logged and must not fail the member or team change that triggered it.
 * @param {FlagUnavailableInput} input Workspace, the person who made the change, and the member or Product affected
 * @return {Promise<void>} Resolves once workflows are updated and notifications attempted
 */
export const flagUnavailableAssignments = async ({ db, workspaceId, actorId, userId, lineageId }: FlagUnavailableInput) => {
	try {
		const workflowIds = (await db.collection<Workflow>(WORKFLOWS_COLLECTION).find(
			{ workspaceId, status: 'in_review', ...(userId ? { 'assignments.userId': userId } : { 'products.lineageId': lineageId }) },
			{ projection: { _id: 1 } },
		).toArray()).map((workflow) => workflow._id!);
		if (workflowIds.length === 0) return;

		const cause: WorkflowUnavailableCause = userId ? 'removed_from_workspace' : 'left_product_team';
		const actor = await getActorSnapshot(db, workspaceId, actorId);
		const events = await workflowEvents(db);

		for (const workflowId of workflowIds) {
			const result = await withTransaction(async (txDb, session) => {
				const workflows = txDb.collection<Workflow>(WORKFLOWS_COLLECTION);
				const workflow = await workflows.findOneAndUpdate(
					{ _id: workflowId, workspaceId, status: 'in_review' },
					{ $set: { assignmentsCheckedAt: new Date() } },
					{ returnDocument: 'after', session },
				);
				if (!workflow) return null;

				const latest = lineageId && await findLatestVersion(txDb, workspaceId, lineageId, session);
				const team = [latest?.owner_user_id, ...(latest?.contributor_user_ids ?? [])].filter((id): id is ObjectId => !!id);
				const affected = workflow.assignments.filter((assignment) => UNDECIDED_DECISIONS.includes(assignment.decision) && (userId
					? assignment.userId.equals(userId)
					: assignment.functionType === 'product_team' && !!assignment.lineageId?.equals(lineageId!)));
				const isUnavailable = (assignment: WorkflowAssignment) => !!userId || !team.some((id) => id.equals(assignment.userId));
				const unavailable = affected.filter((assignment) => isUnavailable(assignment)
					&& (userId ? assignment.needsReplacement !== cause : !assignment.needsReplacement));
				const cleared = affected.filter((assignment) => !isUnavailable(assignment) && assignment.needsReplacement === 'left_product_team');
				if (unavailable.length === 0 && cleared.length === 0) return null;

				await workflows.updateOne(
					{ _id: workflowId, workspaceId, status: 'in_review' },
					{
						...(unavailable.length && { $set: { 'assignments.$[unavailable].needsReplacement': cause } }),
						...(cleared.length && { $unset: { 'assignments.$[cleared].needsReplacement': '' } }),
					},
					{
						arrayFilters: [
							...(unavailable.length ? [{ 'unavailable._id': { $in: unavailable.map((item) => item._id) } }] : []),
							...(cleared.length ? [{ 'cleared._id': { $in: cleared.map((item) => item._id) } }] : []),
						],
						session,
					},
				);

				const flagged = unavailable.filter((assignment) => !assignment.needsReplacement);
				if (actor && flagged.length) {
					const now = new Date();
					await events.insertMany(flagged.map((assignment) => ({
						workspaceId,
						workflowId,
						type: 'approver_unavailable' as const,
						actorSnapshot: actor,
						assignmentId: assignment._id,
						...(assignment.lineageId && { lineageId: assignment.lineageId }),
						data: { functionLabel: assignment.functionLabel, approver: { userId: assignment.userId, ...assignment.userSnapshot }, cause },
						createdAt: now,
					})), { session });
				}
				return { workflow, flagged };
			});
			if (!result?.flagged.length) continue;

			const { workflow, flagged } = result;
			const names = [...new Set(flagged.map((assignment) => assignment.userSnapshot.name))].join(', ');
			await notify({
				...workflowNotification({
					workflow,
					actorId,
					recipients: [],
					type: 'workflow.approver_unavailable',
					title: `${names} can no longer approve ${workflow.numberLabel}`,
					body: userId
						? `${names} left the workspace. Replace them so "${workflow.name}" can complete.`
						: `${names} is no longer on the Product Team. Replace them so "${workflow.name}" can complete.`,
					tab: 'approvals',
				}),
				recipients: [workflow.initiator.userId],
			});
		}
	} catch (err) {
		logError('Flag unavailable workflow assignments failed', err, {
			workspaceId: workspaceId.toString(),
			userId: userId?.toString(),
			lineageId: lineageId?.toString(),
		});
	}
};
