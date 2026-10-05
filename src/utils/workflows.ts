import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ClientSession, Db, ObjectId } from 'mongodb';
import type { Product, ProductStatus } from '../models/product';
import type { User } from '../models/user';
import type { Workspace } from '../models/workspace';
import {
	ACTIVE_WORKFLOW_STATUSES,
	WORKFLOWS_COLLECTION,
	type Workflow,
	type WorkflowRelationship,
} from '../models/workflow';
import { WORKFLOW_COUNTERS_COLLECTION, type WorkflowCounter } from '../models/workflowCounter';
import type { AuthResult } from './authUtils';
import { getDb } from './db';
import { allTabsCompletedFilter, computeCompleteCount } from './productLifecycle';
import { ResponseWrapper } from './responseWrapper';
import { isWorkspaceAdmin, requireTenantContext, type TenantContext } from './tenantContext';

export const WORKFLOWS_DISABLED_MESSAGE = 'Approval workflows are not enabled for this workspace';
export const WORKFLOW_EDIT_FORBIDDEN_MESSAGE = 'Only the Initiator or an admin can change this workflow';
export const WORKFLOW_NOT_DRAFT_MESSAGE = 'Only Draft workflows can be changed';

export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
	draft: 'Draft',
	submitted: 'Submitted',
	in_review: 'In Review',
	released: 'Released',
	obsolete: 'Obsolete',
};

type WorkflowWorkspace = Pick<Workspace, '_id' | 'workspaceName' | 'workflowPrefix' | 'defaultWorkflowCompletionMode'>;

export type WorkflowContextResult =
	| {
		ok: true;
		context: TenantContext;
		auth: Extract<AuthResult, { isValid: true }>;
		db: Db;
		workspace: WorkflowWorkspace;
	}
	| { ok: false; response: APIGatewayProxyResult };

let hasEnsuredIndexes = false;

const ensureWorkflowIndexes = async (db: Db) => {
	if (hasEnsuredIndexes) return;
	const workflows = db.collection<Workflow>(WORKFLOWS_COLLECTION);
	await Promise.all([
		db.collection<WorkflowCounter>(WORKFLOW_COUNTERS_COLLECTION).createIndex({ workspaceId: 1 }, { unique: true }),
		workflows.createIndex({ workspaceId: 1, number: 1 }, { unique: true }),
		workflows.createIndex({ 'workspaceId': 1, 'dates.createdAt': -1 }),
		workflows.createIndex({ 'workspaceId': 1, 'products.lineageId': 1, 'status': 1 }),
	]);
	hasEnsuredIndexes = true;
};

/**
 * Authenticates the request and refuses it with 403 unless approval workflows are enabled for the workspace.
 * @param {APIGatewayProxyEvent} event API Gateway event
 * @return {Promise<WorkflowContextResult>} Tenant context, database and workspace
 */
export const requireWorkflowContext = async (event: APIGatewayProxyEvent): Promise<WorkflowContextResult> => {
	const tenantResult = await requireTenantContext(event);
	if (!tenantResult.ok) return tenantResult;

	const db = await getDb();
	const workspace = await db.collection<Workspace>('workspaces').findOne(
		{ _id: tenantResult.context.workspaceId },
		{ projection: { workspaceName: 1, workflowPrefix: 1, defaultWorkflowCompletionMode: 1, approvalWorkflowsEnabled: 1 } },
	);
	if (workspace?.approvalWorkflowsEnabled !== true) {
		return { ok: false, response: ResponseWrapper.forbidden(WORKFLOWS_DISABLED_MESSAGE) };
	}

	await ensureWorkflowIndexes(db);
	return { ok: true, context: tenantResult.context, auth: tenantResult.auth, db, workspace };
};

export const findWorkflow = (db: Db, workspaceId: ObjectId, workflowId: string | undefined) => {
	if (!workflowId || !ObjectId.isValid(workflowId)) return null;
	return db.collection<Workflow>(WORKFLOWS_COLLECTION).findOne({ _id: new ObjectId(workflowId), workspaceId });
};

export const canManageWorkflow = (user: Pick<TenantContext, 'userId' | 'cognitoGroups'>, workflow: Pick<Workflow, 'initiator'>) =>
	workflow.initiator.userId.equals(user.userId) || isWorkspaceAdmin(user.cognitoGroups);

const PRODUCT_STATE_PROJECTION = {
	product_lineage_id: 1,
	product_name: 1,
	status: 1,
	is_latest: 1,
	is_archived: 1,
	owner_user_id: 1,
	contributor_user_ids: 1,
	...Object.fromEntries(Object.keys(allTabsCompletedFilter).map((path) => [path, 1])),
};

export const lineageIdOf = (product: Pick<Product, '_id' | 'product_lineage_id'>) =>
	product.product_lineage_id ?? (product._id as ObjectId);

export type TeamMember = Pick<User, 'name' | 'email' | 'profileAvatar'> & { _id: ObjectId; relationship: WorkflowRelationship };

/**
 * Finds a Product's active owner and contributors, the people eligible for its Product Team.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace id
 * @param {Product} product Latest version with `owner_user_id` and `contributor_user_ids`
 * @return {Promise<TeamMember[]>} Owner first, then contributors
 */
export const getProductTeam = async (db: Db, workspaceId: ObjectId, product: Pick<Product, 'owner_user_id' | 'contributor_user_ids'>) => {
	const ids = [product.owner_user_id, ...(product.contributor_user_ids ?? [])].filter((id): id is ObjectId => !!id);
	if (ids.length === 0) return [];

	const users = await db.collection<User>('users')
		.find({ _id: { $in: ids }, workspaceId, status: 'active' }, { projection: { name: 1, email: 1, profileAvatar: 1 } })
		.toArray();
	return users
		.map((user): TeamMember => ({
			_id: user._id!,
			name: user.name,
			email: user.email,
			profileAvatar: user.profileAvatar,
			relationship: product.owner_user_id?.equals(user._id!) ? 'product_owner' : 'product_contributor',
		}))
		.sort((a, b) => Number(b.relationship === 'product_owner') - Number(a.relationship === 'product_owner'));
};

/**
 * Loads the current state of a workflow's Products: the included version, the lineage's latest version,
 * and other active workflows that hold the same Products.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @param {ClientSession} session Optional transaction session
 * @return {Promise<Object>} Lookups keyed by lineage id
 */
export const loadWorkflowProductState = async (db: Db, workflow: Workflow, session?: ClientSession) => {
	const lineageIds = workflow.products.map((product) => product.lineageId);
	const versionIds = workflow.products.map((product) => product.productVersionId);
	if (lineageIds.length === 0) {
		return { included: new Map<string, Product>(), latest: new Map<string, Product>(), activeElsewhere: new Map<string, string>() };
	}

	const products = await db.collection<Product>('products').find({
		workspace_id: workflow.workspaceId,
		$or: [{ _id: { $in: versionIds } }, { product_lineage_id: { $in: lineageIds }, is_latest: true }],
	}, { projection: PRODUCT_STATE_PROJECTION, session }).toArray();
	const otherWorkflows = await db.collection<Workflow>(WORKFLOWS_COLLECTION).find({
		'workspaceId': workflow.workspaceId,
		'_id': { $ne: workflow._id },
		'status': { $in: ACTIVE_WORKFLOW_STATUSES },
		'products.lineageId': { $in: lineageIds },
	}, { projection: { 'numberLabel': 1, 'products.lineageId': 1 }, session }).toArray();

	const included = new Map<string, Product>();
	const latest = new Map<string, Product>();
	for (const product of products) {
		const lineageId = lineageIdOf(product).toString();
		if (versionIds.some((id) => id.equals(product._id!))) included.set(lineageId, product);
		if (product.is_latest) latest.set(lineageId, product);
	}

	const activeElsewhere = new Map<string, string>();
	for (const other of otherWorkflows) {
		for (const product of other.products) activeElsewhere.set(product.lineageId.toString(), other.numberLabel);
	}

	return { included, latest, activeElsewhere };
};

export type ReadinessCheck = {
	key: string;
	label: string;
	passed: boolean;
	message: string;
};

const listNames = (names: string[]) => names.join(', ');

/**
 * Checks that approval is shared: neither the Initiator nor a Product Owner may be the workflow's only approver.
 * @param {Workflow} workflow Workflow with the assignments to check
 * @param {Map<string, Product>} latest Each Product's latest version from `loadWorkflowProductState`
 * @return {string | null} The problem, or null when approval is shared
 */
export const getSoleApproverProblem = (workflow: Pick<Workflow, 'assignments' | 'initiator'>, latest: Map<string, Product>) => {
	const assigneeIds = new Set(workflow.assignments.map((assignment) => assignment.userId.toString()));
	if (assigneeIds.size !== 1) return null;
	const [soleApprover] = assigneeIds;
	if (soleApprover === workflow.initiator.userId.toString()) return 'The Initiator is the only approver. Add someone else.';
	const ownerIds = new Set([...latest.values()].map((product) => product.owner_user_id?.toString()));
	return ownerIds.has(soleApprover) ? 'The Product Owner is the only approver. Add someone else.' : null;
};

/**
 * Runs the "ready to start?" checks for a Draft workflow.
 * @param {Db} db Database handle
 * @param {Workflow} workflow Workflow
 * @param {ClientSession} session Optional transaction session, so Start can re-check inside its transaction
 * @return {Promise<ReadinessCheck[]>} Every check with pass or fail and a simple message
 */
export const getWorkflowReadiness = async (db: Db, workflow: Workflow, session?: ClientSession): Promise<ReadinessCheck[]> => {
	const { included, latest, activeElsewhere } = await loadWorkflowProductState(db, workflow, session);
	const hasProducts = workflow.products.length > 0;
	const noProductsMessage = 'Add a Product first';

	const versionProblems = workflow.products.flatMap((product) => {
		const key = product.lineageId.toString();
		const version = included.get(key);
		if (!version) return [`${product.name} no longer exists`];
		const problems: string[] = [];
		if (version.is_archived) problems.push(`${product.name} is archived`);
		if (!version.is_latest) problems.push(`${product.name} has a newer version`);
		if (version.status !== 'submitted') problems.push(`${product.name} is ${PRODUCT_STATUS_LABELS[version.status] ?? version.status}`);
		const completeCount = computeCompleteCount(version);
		if (completeCount < 100) problems.push(`${product.name} is ${completeCount}% complete`);
		return problems;
	});

	const busyProducts = workflow.products
		.filter((product) => activeElsewhere.has(product.lineageId.toString()))
		.map((product) => `${product.name} (${activeElsewhere.get(product.lineageId.toString())})`);

	const productTeamAssignments = workflow.assignments.filter((assignment) => assignment.functionType === 'product_team');
	const missingProductTeam = workflow.products
		.filter((product) => !productTeamAssignments.some((assignment) => assignment.lineageId?.equals(product.lineageId)))
		.map((product) => product.name);
	const offTeam = workflow.products.flatMap((product) => {
		const team = latest.get(product.lineageId.toString());
		return productTeamAssignments
			.filter((assignment) => assignment.lineageId?.equals(product.lineageId)
				&& !team?.owner_user_id?.equals(assignment.userId)
				&& !team?.contributor_user_ids?.some((id) => id.equals(assignment.userId)))
			.map((assignment) => `${assignment.userSnapshot.name} (${product.name})`);
	});
	const functionCount = workflow.assignments.filter((assignment) => assignment.functionType === 'function').length;

	const assigneeIds = [...new Map(workflow.assignments.map((assignment) => [assignment.userId.toString(), assignment.userId])).values()];
	const activeIds = new Set(assigneeIds.length === 0 ? [] : (await db.collection<User>('users')
		.find({ _id: { $in: assigneeIds }, workspaceId: workflow.workspaceId, status: 'active' }, { projection: { _id: 1 }, session })
		.toArray()).map((user) => user._id!.toString()));
	const inactiveNames = [...new Set(workflow.assignments
		.filter((assignment) => !activeIds.has(assignment.userId.toString()))
		.map((assignment) => assignment.userSnapshot.name))];
	const missingLabels = workflow.assignments.filter((assignment) => !assignment.functionLabel.trim()).length;

	const soleApproverMessage = getSoleApproverProblem(workflow, latest);

	return [
		{
			key: 'products',
			label: 'At least 1 Product',
			passed: hasProducts,
			message: hasProducts ? `${workflow.products.length} added` : noProductsMessage,
		},
		{
			key: 'product_versions',
			label: 'Every Product is Latest, Submitted, and 100% complete',
			passed: hasProducts && versionProblems.length === 0,
			message: !hasProducts ? noProductsMessage : versionProblems.length ? versionProblems.join('; ') : 'All Products are ready',
		},
		{
			key: 'other_active_workflows',
			label: 'No Product is in another active workflow',
			passed: hasProducts && busyProducts.length === 0,
			message: !hasProducts ? noProductsMessage : busyProducts.length ? `Already in review: ${listNames(busyProducts)}` : 'No conflicts',
		},
		{
			key: 'product_team',
			label: 'Every Product has a Product Team approver',
			passed: hasProducts && missingProductTeam.length === 0 && offTeam.length === 0,
			message: !hasProducts
				? noProductsMessage
				: [
					missingProductTeam.length && `Missing for ${listNames(missingProductTeam)}`,
					offTeam.length && `No longer on the Product Team: ${listNames(offTeam)}. Replace them.`,
				].filter(Boolean).join('; ') || 'Every Product is covered',
		},
		{
			key: 'functions',
			label: 'At least 1 other Function is assigned',
			passed: functionCount > 0,
			message: functionCount > 0 ? `${functionCount} assigned` : 'Add an approver under a Function such as Quality',
		},
		{
			key: 'assignees',
			label: 'Every approver is an active member with a Function',
			passed: workflow.assignments.length > 0 && inactiveNames.length === 0 && missingLabels === 0,
			message: workflow.assignments.length === 0
				? 'Add approvers first'
				: inactiveNames.length
					? `No longer active: ${listNames(inactiveNames)}`
					: missingLabels ? `${missingLabels} approver(s) have no Function` : 'All approvers are active',
		},
		{
			key: 'independent_approval',
			label: 'Neither the Product Owner nor the Initiator is the only approver',
			passed: workflow.assignments.length > 0 && !soleApproverMessage,
			message: workflow.assignments.length === 0 ? 'Add approvers first' : soleApproverMessage ?? 'Approval is shared',
		},
	];
};
