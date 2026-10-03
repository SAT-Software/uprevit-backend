import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId, type Filter } from 'mongodb';
import { WORKFLOW_STATUSES, WORKFLOWS_COLLECTION, type Workflow, type WorkflowStatus } from '../../models/workflow';
import { parseListQuery } from '../../utils/listQuery';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { parseWorkflowNumberSearch } from '../../utils/workflowNumber';
import { requireWorkflowContext } from '../../utils/workflows';

const VIEWS = ['all', 'created-by-me', 'my-tasks'] as const;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lists workflows, newest first. Supports `view`, `search` (number or name), `status` and `productLineageId`.
 * `my-tasks` lists started workflows assigned to the caller, with their pending decisions first.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db } = workflowResult;
		const query = event.queryStringParameters ?? {};

		const listQuery = parseListQuery({ query, allowedSortFields: ['createdAt'], defaultSort: 'createdAt', defaultOrder: 'desc' });
		if (listQuery.error) return listQuery.error;
		const { page, limit, skip, order } = listQuery.value!;

		const view = query.view ?? 'all';
		if (!VIEWS.includes(view as typeof VIEWS[number])) return ResponseWrapper.badRequest(`view must be one of: ${VIEWS.join(', ')}`);

		const filter: Filter<Workflow> = { workspaceId: context.workspaceId };
		if (view === 'created-by-me') filter['initiator.userId'] = context.userId;
		if (view === 'my-tasks') {
			filter['assignments.userId'] = context.userId;
			filter.$and = [{ status: { $ne: 'draft' } }];
		}

		if (query.status) {
			if (!WORKFLOW_STATUSES.includes(query.status as WorkflowStatus)) {
				return ResponseWrapper.badRequest(`status must be one of: ${WORKFLOW_STATUSES.join(', ')}`);
			}
			filter.status = query.status as WorkflowStatus;
		}

		if (query.productLineageId) {
			if (!ObjectId.isValid(query.productLineageId)) return ResponseWrapper.badRequest('Invalid productLineageId');
			filter['products.lineageId'] = new ObjectId(query.productLineageId);
		}

		const search = query.search?.trim();
		if (search) {
			const number = parseWorkflowNumberSearch(search);
			filter.$or = [
				{ name: { $regex: escapeRegex(search), $options: 'i' } },
				{ numberLabel: { $regex: escapeRegex(search), $options: 'i' } },
				...(number !== null ? [{ number }] : []),
			];
		}

		const direction = order === 'asc' ? 1 : -1;
		const workflows = db.collection<Workflow>(WORKFLOWS_COLLECTION);
		const sort = { 'dates.createdAt': direction, '_id': direction } as const;
		const [items, totalCount] = await Promise.all([
			view === 'my-tasks'
				? workflows.aggregate<Workflow>([
					{ $match: filter },
					{
						$addFields: {
							hasMyPendingDecision: {
								$and: [
									{ $eq: ['$status', 'in_review'] },
									{ $anyElementTrue: [{ $map: { input: '$assignments', as: 'a', in: { $and: [{ $eq: ['$$a.userId', context.userId] }, { $eq: ['$$a.decision', 'pending'] }] } } }] },
								],
							},
						},
					},
					{ $sort: { hasMyPendingDecision: -1, ...sort } },
					{ $skip: skip },
					{ $limit: limit },
					{ $project: { hasMyPendingDecision: 0 } },
				]).toArray()
				: workflows.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
			workflows.countDocuments(filter),
		]);
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Workflows fetched successfully',
			result: {
				workflows: items,
				pagination: {
					currentPage: page,
					totalPages,
					totalCount,
					limit,
					hasNextPage: page < totalPages,
					hasPrevPage: page > 1,
				},
			},
		});
	} catch (err) {
		logError('Get workflows handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get workflows');
	}
};
