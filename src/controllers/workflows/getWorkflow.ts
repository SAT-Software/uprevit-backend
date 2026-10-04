import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Db, ObjectId } from 'mongodb';
import type { Product } from '../../models/product';
import { ACTIVE_WORKFLOW_STATUSES, type Workflow } from '../../models/workflow';
import { WORKFLOW_DISCUSSION_COLLECTION, type WorkflowDiscussionItem } from '../../models/workflowDiscussion';
import { buildLegacyAuditLookupStage, PRODUCT_ACTIVITY_UPDATE_ACTIONS } from '../../utils/auditLogV2Aggregation';
import { logError } from '../../utils/logger';
import { computeCompleteCount } from '../../utils/productLifecycle';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';
import {
	canManageWorkflow,
	findWorkflow,
	getProductTeam,
	loadWorkflowProductState,
	requireWorkflowContext,
} from '../../utils/workflows';

type ProductAudit = { action: 'create' | 'update'; actionBy: string; actionAt: Date };

const loadProductAudits = async (db: Db, workflow: Workflow) => {
	if (workflow.products.length === 0) return new Map<string, ProductAudit[]>();
	const versions = await db.collection<Product>('products').aggregate<{ _id: ObjectId; auditLogs: ProductAudit[] }>([
		{ $match: { workspace_id: workflow.workspaceId, _id: { $in: workflow.products.map((product) => product.productVersionId) } } },
		buildLegacyAuditLookupStage({ scopeType: 'product', updateActions: PRODUCT_ACTIVITY_UPDATE_ACTIONS }),
		{ $project: { auditLogs: 1 } },
	]).toArray();
	return new Map(versions.map((version) => [version._id.toString(), version.auditLogs]));
};

const loadOpenChangeRequestCounts = async (db: Db, workflow: Workflow) => {
	const counts = await db.collection<WorkflowDiscussionItem>(WORKFLOW_DISCUSSION_COLLECTION).aggregate<{ _id: ObjectId; count: number }>([
		{ $match: { workspaceId: workflow.workspaceId, workflowId: workflow._id, kind: 'change_request', status: 'open' } },
		{ $group: { _id: '$assignmentId', count: { $sum: 1 } } },
	]).toArray();
	return new Map(counts.map(({ _id, count }) => [_id.toString(), count]));
};

/**
 * Gets a workflow with the current state of its Products, each Product's eligible Product Team, and each assignment's
 * open change requests.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db } = workflowResult;
		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');

		const [{ included, latest }, audits, openChangeRequests] = await Promise.all([
			loadWorkflowProductState(db, workflow),
			loadProductAudits(db, workflow),
			loadOpenChangeRequestCounts(db, workflow),
		]);
		const signingOptions = { workspaceId: context.workspaceId, pendingOwnerId: context.cognitoSub };

		const products = await Promise.all(workflow.products.map(async (product) => {
			const key = product.lineageId.toString();
			const version = included.get(key);
			const latestVersion = latest.get(key);
			const auditLogs = audits.get(product.productVersionId.toString()) ?? [];
			const created = auditLogs.find((log) => log.action === 'create');
			const modified = auditLogs.find((log) => log.action === 'update');
			return {
				...product,
				status: version?.status ?? null,
				completeCount: version ? computeCompleteCount(version) : null,
				isLatest: version?.is_latest ?? false,
				isArchived: version?.is_archived ?? false,
				createdBy: created?.actionBy ?? null,
				createdOn: created?.actionAt ?? null,
				modifiedBy: modified?.actionBy ?? null,
				modifiedOn: modified?.actionAt ?? null,
				team: latestVersion
					? await enrichUsersWithProfileAvatarUrls(await getProductTeam(db, context.workspaceId, latestVersion), signingOptions)
					: [],
			};
		}));

		return ResponseWrapper.success({
			message: 'Workflow fetched successfully',
			workflow: {
				...workflow,
				products,
				assignments: workflow.assignments.map((assignment) => ({
					...assignment,
					openChangeRequestCount: openChangeRequests.get(assignment._id.toString()) ?? 0,
				})),
				canEdit: workflow.status === 'draft' && canManageWorkflow(context, workflow),
				canCancel: ACTIVE_WORKFLOW_STATUSES.includes(workflow.status) && canManageWorkflow(context, workflow),
				canComplete: workflow.status === 'ready_to_complete' && canManageWorkflow(context, workflow),
			},
		});
	} catch (err) {
		logError('Get workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get workflow');
	}
};
