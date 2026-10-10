import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId, type Filter } from 'mongodb';
import { ACTIVE_WORKFLOW_STATUSES } from '../../models/workflow';
import { WORKFLOW_DISCUSSION_KINDS, type WorkflowDiscussionItem, type WorkflowDiscussionKind } from '../../models/workflowDiscussion';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { canAddressRequest, canComment, getProductTeamIds, withAttachmentUrls, workflowDiscussion } from '../../utils/workflowDiscussion';
import { findWorkflow, requireWorkflowContext } from '../../utils/workflows';

/**
 * Returns a workflow's comments and change requests, oldest first. Filters by `kind` (comment or change_request) and by
 * scope (`scope=package`, or `scope=product` with `lineageId`). Each change request says whether the caller can address it.
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

		const query = event.queryStringParameters ?? {};
		const filter: Filter<WorkflowDiscussionItem> = { workspaceId: context.workspaceId, workflowId: workflow._id };
		if (query.kind) {
			if (!WORKFLOW_DISCUSSION_KINDS.includes(query.kind as WorkflowDiscussionKind)) {
				return ResponseWrapper.badRequest(`kind must be one of: ${WORKFLOW_DISCUSSION_KINDS.join(', ')}`);
			}
			filter.kind = query.kind as WorkflowDiscussionKind;
		}
		if (query.scope === 'package') {
			filter['scope.type'] = 'package';
		} else if (query.scope === 'product') {
			filter['scope.type'] = 'product';
			if (query.lineageId) {
				if (!ObjectId.isValid(query.lineageId)) return ResponseWrapper.badRequest('Invalid lineageId');
				filter['scope.lineageId'] = new ObjectId(query.lineageId);
			}
		} else if (query.scope) {
			return ResponseWrapper.badRequest('scope must be one of: package, product');
		}

		const [items, teams] = await Promise.all([
			(await workflowDiscussion(db)).find(filter).sort({ createdAt: 1, _id: 1 }).toArray(),
			getProductTeamIds(db, workflow),
		]);
		const isActive = ACTIVE_WORKFLOW_STATUSES.includes(workflow.status);

		return ResponseWrapper.success({
			message: 'Workflow discussion fetched successfully',
			items: (await withAttachmentUrls(items, context.workspaceId)).map((item) => ({
				...item,
				canAddress: isActive && item.kind === 'change_request' && item.status === 'open'
					&& canAddressRequest(context.userId, workflow, teams, item.scope),
			})),
			canComment: isActive && canComment(context, workflow, teams),
		});
	} catch (err) {
		logError('Get workflow discussion handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get workflow discussion');
	}
};
