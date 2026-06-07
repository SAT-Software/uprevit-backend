import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Filter, ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { buildListFiltersMatch, parseListQuery } from '../../utils/listQuery';
import { BILLING_ACCOUNTS_COLLECTION, type BillingAccount } from '../../models/billing';
import { Workspace } from '../../models/workspace';
import { serializeWorkspaceListItem } from '../../utils/platformAdminSerializers';

const ALLOWED_SORT_FIELDS = ['workspaceName', 'companyName', 'memberCount'];
const LIST_FILTER_FIELDS = {
	workspaceName: { path: 'workspaceName', type: 'text' as const },
	companyName: { path: 'companyName', type: 'text' as const },
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Searchable workspace directory for platform operators.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Paginated workspace directory
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const parsed = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ALLOWED_SORT_FIELDS,
			defaultSort: 'workspaceName',
			defaultOrder: 'asc',
		});
		if (parsed.error) return parsed.error;
		const { page, limit, sort, order, skip, filters } = parsed.value!;

		const search = event.queryStringParameters?.search?.trim();
		const db = await getDb();
		const match: Filter<Workspace> = {};

		if (search) {
			const pattern = escapeRegex(search);
			match.$or = [
				{ workspaceName: { $regex: pattern, $options: 'i' } },
				{ companyName: { $regex: pattern, $options: 'i' } },
			];
		}

		const filterMatch = buildListFiltersMatch(filters, LIST_FILTER_FIELDS);
		if (filterMatch.error) return filterMatch.error;
		if (filterMatch.match) {
			Object.assign(match, filterMatch.match);
		}

		const sortDirection = order === 'asc' ? 1 : -1;
		const sortField = sort === 'memberCount' ? 'memberCount' : sort;

		const pipeline = [
			{ $match: match },
			{
				$lookup: {
					from: 'users',
					let: { workspaceId: '$_id' },
					pipeline: [
						{ $match: { $expr: { $eq: ['$workspaceId', '$$workspaceId'] } } },
						{ $count: 'count' },
					],
					as: 'memberStats',
				},
			},
			{
				$addFields: {
					memberCount: {
						$ifNull: [{ $arrayElemAt: ['$memberStats.count', 0] }, 0],
					},
				},
			},
			{ $project: { memberStats: 0 } },
			{ $sort: { [sortField]: sortDirection, _id: 1 } },
			{
				$facet: {
					items: [{ $skip: skip }, { $limit: limit }],
					total: [{ $count: 'count' }],
				},
			},
		];

		const [result] = await db.collection<Workspace>('workspaces').aggregate(pipeline).toArray();
		const items = (result?.items ?? []) as Array<Workspace & { _id: ObjectId; memberCount: number }>;
		const total = result?.total?.[0]?.count ?? 0;
		const workspaceIds = items.map((workspace) => workspace._id).filter(Boolean);
		const billingAccounts = workspaceIds.length
			? await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION)
				.find({ workspaceId: { $in: workspaceIds } })
				.toArray()
			: [];
		const billingByWorkspaceId = new Map(
			billingAccounts.map((account) => [account.workspaceId.toString(), account]),
		);

		return ResponseWrapper.success({
			message: 'Workspaces retrieved',
			data: {
				items: items
					.filter((workspace): workspace is Workspace & { _id: ObjectId; memberCount: number } => Boolean(workspace._id))
					.map((workspace) => serializeWorkspaceListItem(
						workspace,
						billingByWorkspaceId.get(workspace._id.toString()) ?? null,
					)),
				pagination: {
					page,
					limit,
					total,
					totalPages: Math.max(1, Math.ceil(total / limit)),
				},
			},
		});
	} catch (error) {
		logError('Platform admin list workspaces failed', error);
		return ResponseWrapper.internalServerError('Failed to list workspaces');
	}
};
