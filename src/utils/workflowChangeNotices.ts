import { ClientSession, Db, Document, Filter, ObjectId, UpdateFilter, UpdateOptions } from 'mongodb';
import type { Product } from '../models/product';
import { ACTIVE_WORKFLOW_STATUSES, WORKFLOWS_COLLECTION, type Workflow, type WorkflowActorSnapshot, type WorkflowAssignment } from '../models/workflow';
import { getDb, withTransaction } from './db';
import { emailNotifications, ensureNotificationIndexes, saveNotifications } from './notifications';
import { didReviewedContentChange } from './productContentChange';
import { PRODUCT_EDIT_FORBIDDEN_MESSAGE, ProductAccessError } from './productAccess';
import { JUST_RELEASED_MESSAGE, LifecycleConflictError } from './productLifecycle';
import { WorkflowConflictError, getActorSnapshot, workflowEvents, workflowNotification } from './workflowLifecycle';
import { lineageIdOf } from './workflows';

type ChangeNotice = Array<{ users: Awaited<ReturnType<typeof saveNotifications>>; input: ReturnType<typeof workflowNotification> }>;

type RecordContentChangeInput = {
	db: Db;
	session: ClientSession;
	product: Product;
	actorId: ObjectId;
	now: Date;
};

/**
 * Inside the save transaction, bumps an In Review version's `content_revision`, saves an in-app Change Notice for every
 * approver who has not had one since their last decision, and records a `content_changed` event. Decisions and the
 * workflow status never change. The conditional writes make a concurrent completion and save conflict, so only one wins.
 * @param {RecordContentChangeInput} input Transaction, the saved version and the editor
 * @return {Promise<ChangeNotice>} The notices to email once the transaction commits
 */
const recordContentChange = async ({ db, session, product, actorId, now }: RecordContentChangeInput): Promise<ChangeNotice> => {
	const actor = await getActorSnapshot(db, product.workspace_id, actorId);
	if (!actor) throw new ProductAccessError(PRODUCT_EDIT_FORBIDDEN_MESSAGE);

	const fromRevision = product.content_revision ?? 0;
	const bumped = await db.collection<Product>('products').updateOne(
		{ _id: product._id, status: 'in_review', active_workflow_id: product.active_workflow_id },
		{ $inc: { content_revision: 1 } },
		{ session },
	);
	if (bumped.matchedCount === 0) throw new LifecycleConflictError(JUST_RELEASED_MESSAGE);

	const workflow = await db.collection<Workflow>(WORKFLOWS_COLLECTION).findOneAndUpdate(
		{ _id: product.active_workflow_id, workspaceId: product.workspace_id, status: { $in: ACTIVE_WORKFLOW_STATUSES } },
		{ $set: { 'contentUpdatedAt': now, 'assignments.$[unnotified].changeNoticeSent': true } },
		{
			arrayFilters: [{ 'unnotified.changeNoticeSent': { $ne: true }, 'unnotified.userId': { $ne: actorId } }],
			returnDocument: 'before',
			session,
		},
	);
	if (!workflow) throw new WorkflowConflictError('This workflow has already ended. Reload and try again.');

	const recipients = workflow.assignments.filter((assignment) => assignment.changeNoticeSent !== true && !assignment.userId.equals(actorId));
	await (await workflowEvents(db)).insertOne({
		workspaceId: workflow.workspaceId,
		workflowId: workflow._id!,
		type: 'content_changed',
		actorSnapshot: actor,
		lineageId: lineageIdOf(product),
		data: {
			productVersionId: product._id,
			productName: product.product_name,
			fromRevision,
			toRevision: fromRevision + 1,
			notified: [...new Set(recipients.map((assignment) => assignment.userSnapshot.name))],
		},
		createdAt: now,
	}, { session });

	const notices: ChangeNotice = [];
	for (const input of changeNotices(workflow, actor, product.product_name, recipients)) {
		notices.push({ users: await saveNotifications(db, input, session), input });
	}
	return notices;
};

/**
 * Builds the Change Notices: anyone with a decision still to make is told to review first; the rest are told their
 * approval still counts.
 * @param {Workflow} workflow Workflow
 * @param {WorkflowActorSnapshot} actor Editor
 * @param {string} productName Changed Product
 * @param {WorkflowAssignment[]} recipients Assignments to notify
 * @return {Array} Notification inputs
 */
const changeNotices = (workflow: Workflow, actor: WorkflowActorSnapshot, productName: string, recipients: WorkflowAssignment[]) => {
	const undecided = recipients.filter((assignment) => assignment.decision !== 'approved').map((assignment) => assignment.userId);
	const undecidedKeys = new Set(undecided.map((id) => id.toString()));
	const approved = recipients.map((assignment) => assignment.userId).filter((id) => !undecidedKeys.has(id.toString()));
	const title = `${productName} changed in ${workflow.numberLabel}`;
	const notice = { workflow, actorId: actor.userId, type: 'workflow.content_changed' as const, tab: 'approvals' as const };

	return [
		workflowNotification({
			...notice,
			recipients: approved,
			title: `${title} after your decision`,
			body: `${actor.name} saved a change. Your approval still counts. Review the changes and approve again if you want.`,
		}),
		workflowNotification({
			...notice,
			recipients: undecided,
			title,
			body: `${actor.name} saved a change. Review the latest content before you decide.`,
		}),
	];
};

type SaveProductContentInput = {
	productFilter: Filter<Product>;
	writeFilter: Filter<Product>;
	update: UpdateFilter<Product> | Document[];
	options?: UpdateOptions;
	actorId: ObjectId;
};

/**
 * Saves a Product content update in a transaction. When an In Review version's reviewed content really changed, the
 * same transaction bumps its revision and saves the in-app Change Notices; email them with `sendChangeNotices` after it commits.
 * @param {SaveProductContentInput} input Filters, update and the editor
 * @return {Promise<Object>} The update result, the version before and after the save, and the pending Change Notice
 */
export const saveProductContent = async ({ productFilter, writeFilter, update, options, actorId }: SaveProductContentInput) => {
	await Promise.all([getDb().then(workflowEvents), ensureNotificationIndexes()]);
	return withTransaction(async (db, session) => {
		const products = db.collection<Product>('products');
		const before = await products.findOne(productFilter, { session });
		const result = await products.updateOne(writeFilter, update, { ...options, session });
		if (!before || result.modifiedCount === 0) return { result, before, after: before, changeNotice: null };

		const after = (await products.findOne(productFilter, { session }))!;
		const changed = before.status === 'in_review' && !!before.active_workflow_id && didReviewedContentChange(before, after);
		const changeNotice = changed ? await recordContentChange({ db, session, product: after, actorId, now: new Date() }) : null;
		return { result, before, after, changeNotice };
	});
};

/**
 * Emails the Change Notices saved by `saveProductContent`.
 * @param {ChangeNotice | null} notice Saved notices, if the save changed reviewed content
 * @return {Promise<void>} Resolves once emails are attempted
 */
export const sendChangeNotices = async (notice: ChangeNotice | null) => {
	await Promise.all((notice ?? []).map(({ users, input }) => emailNotifications(users, input)));
};
