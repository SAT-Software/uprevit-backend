import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { UserBookmarks } from '../../models/bookmarks';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';
import { buildListFiltersMatch, ListFilterField, parseListQuery } from '../../utils/listQuery';

const ALLOWED_SORT_FIELDS = [
	'product_name',
	'product_plan_number',
	'product_description',
	'project_name',
	'department_name',
	'version',
	'status',
	'target_date',
	'complete_count',
	'createdBy',
	'createdOn',
	'modifiedBy',
	'modifiedOn',
	'archivedBy',
	'archivedOn',
	'actionBy',
	'actionAt',
	'_id',
];

const ACTIVE_FILTER_FIELDS: Record<string, ListFilterField> = {
	product_name: { path: 'product_name', type: 'text' },
	product_plan_number: { path: 'product_plan_number', type: 'text' },
	project_name: { path: 'project_name', type: 'text' },
	department_name: { path: 'department_name', type: 'text' },
	status: { path: 'status', type: 'text' },
	version: { path: 'version', type: 'number' },
	complete_count: { path: 'complete_count', type: 'number' },
	progress: { path: 'complete_count', type: 'number' },
	createdBy: { path: 'createdBy', type: 'text' },
	createdOn: { path: 'createdOn', type: 'date' },
	modifiedBy: { path: 'modifiedBy', type: 'text' },
	modifiedOn: { path: 'modifiedOn', type: 'date' },
};

const ARCHIVE_FILTER_FIELDS: Record<string, ListFilterField> = {
	product_name: { path: 'product_name', type: 'text' },
	product_plan_number: { path: 'product_plan_number', type: 'text' },
	project_name: { path: 'project_name', type: 'text' },
	department_name: { path: 'department_name', type: 'text' },
	version: { path: 'version', type: 'number' },
	complete_count: { path: 'complete_count', type: 'number' },
	progress: { path: 'complete_count', type: 'number' },
	archivedBy: { path: 'archivedBy', type: 'text' },
	archivedOn: { path: 'archivedOn', type: 'date' },
};

/**
 * Returns a success response with an empty products array when no bookmarked products are found.
 * @param {number} page - The current page number.
 * @param {number} limit - The number of items per page.
 * @return {APIGatewayProxyResult} A success response with an empty products array.
 */
function emptyProductsResult(page: number, limit: number): APIGatewayProxyResult {
	return ResponseWrapper.success({
		message: 'No bookmarked products found',
		result: {
			products: [],
			pagination: {
				currentPage: page,
				totalPages: 0,
				totalCount: 0,
				limit,
				hasNextPage: false,
				hasPrevPage: false,
			},
		},
	});
}


export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const db = await getDb();

		const listQueryResult = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ALLOWED_SORT_FIELDS,
			defaultSort: 'product_name',
		});
		if (listQueryResult.error) return listQueryResult.error;

		const { limit, page, skip, sort, order, filters } = listQueryResult.value!;
		const isLatest = event.queryStringParameters?.isLatest || 'true';
		const statusFilter = event.queryStringParameters?.status;
		const filterParam = event.queryStringParameters?.filter;
		const requestedWorkspaceId = event.queryStringParameters?.workspaceId;
		const projectId = event.queryStringParameters?.projectId;
		const departmentId = event.queryStringParameters?.departmentId;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspaceId');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const bookmarks = await db.collection<UserBookmarks>('bookmarks').findOne({
			user_id: context.userId,
			workspace_id: context.workspaceId,
		});

		const bookmarkedProductIds = new Set<ObjectId>();
		for (const folder of bookmarks?.product_folders ?? []) {
			for (const productId of folder.products ?? []) {
				bookmarkedProductIds.add(productId);
			}
		}

		if (bookmarkedProductIds.size === 0) {
			return emptyProductsResult(page, limit);
		}

		const filter: Record<string, unknown> = {
			workspace_id: context.workspaceId,
			_id: { $in: Array.from(bookmarkedProductIds) },
		};
		let statusValues: string[] | null = null;

		if (projectId) {
			if (!ObjectId.isValid(projectId)) return ResponseWrapper.badRequest('Invalid projectId');
			filter.project_id = new ObjectId(projectId);
		}

		if (departmentId) {
			if (!ObjectId.isValid(departmentId)) return ResponseWrapper.badRequest('Invalid departmentId');
			filter.department_id = new ObjectId(departmentId);
		}

		if (statusFilter) {
			try {
				const statusArray = JSON.parse(statusFilter);
				if (Array.isArray(statusArray) && statusArray.length > 0) {
					const statusStrings = statusArray.filter(
						(status): status is string => typeof status === 'string',
					);
					if (statusStrings.length > 0) {
						filter.status = { $in: statusStrings };
						statusValues = statusStrings;
					}
				}
			} catch {
				filter.status = statusFilter;
				statusValues = [statusFilter];
			}
		} else {
			filter.status = { $in: ['draft', 'submitted'] };
			statusValues = ['draft', 'submitted'];
		}

		const isArchiveOnlyStatus = statusValues?.length === 1 && statusValues[0] === 'archived';

		if (filterParam) {
			filter.$or = [
				{ product_name: { $regex: filterParam, $options: 'i' } },
				{ product_plan_number: { $regex: filterParam, $options: 'i' } },
				{ product_description: { $regex: filterParam, $options: 'i' } },
			];
		}

		if (isLatest) {
			filter.is_latest = true;
		}

		const pipeline: any[] = [
			{ $match: filter },
			buildLegacyAuditLookupStage(
				isArchiveOnlyStatus
					? { scopeType: 'product', mode: 'archive' }
					: {
						scopeType: 'product',
						updateActions: ['update', 'submit', 'delete', 'move', 'link', 'unlink', 'restore'],
					}
			),
			{
				$lookup: {
					from: 'departments',
					localField: 'department_id',
					foreignField: '_id',
					as: 'department',
					pipeline: [{ $project: { department_name: 1 } }],
				},
			},
			{
				$lookup: {
					from: 'projects',
					localField: 'project_id',
					foreignField: '_id',
					as: 'project',
					pipeline: [{ $project: { project_name: 1 } }],
				},
			},
		];

		pipeline.push({
			$addFields: {
				project_name: { $arrayElemAt: ['$project.project_name', 0] },
				department_name: { $arrayElemAt: ['$department.department_name', 0] },
				actionBy: { $arrayElemAt: ['$auditLogs.actionBy', 0] },
				actionAt: { $arrayElemAt: ['$auditLogs.actionAt', 0] },
				createdAudit: {
					$first: {
						$filter: { input: '$auditLogs', as: 'auditLog', cond: { $eq: ['$$auditLog.action', 'create'] } },
					},
				},
				modifiedAudit: {
					$first: {
						$filter: { input: '$auditLogs', as: 'auditLog', cond: { $eq: ['$$auditLog.action', 'update'] } },
					},
				},
			},
		});
		pipeline.push({
			$addFields: {
				createdBy: '$createdAudit.actionBy',
				createdOn: '$createdAudit.actionAt',
				modifiedBy: '$modifiedAudit.actionBy',
				modifiedOn: '$modifiedAudit.actionAt',
				archivedBy: '$actionBy',
				archivedOn: '$actionAt',
			},
		});

		const filtersMatch = buildListFiltersMatch(
			filters,
			isArchiveOnlyStatus ? ARCHIVE_FILTER_FIELDS : ACTIVE_FILTER_FIELDS,
		);
		if (filtersMatch.error) return filtersMatch.error;
		if (filtersMatch.match) pipeline.push({ $match: filtersMatch.match });

		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sort] = order === 'desc' ? -1 : 1;
		pipeline.push({ $sort: sortObj });

		pipeline.push({ $skip: skip });
		pipeline.push({ $limit: limit });

		const countPipeline = pipeline.slice(0, -3).concat({ $count: 'total' });

		const [products, countResult] = await Promise.all([
			db.collection<Product>('products').aggregate(pipeline).toArray(),
			db.collection<Product>('products').aggregate(countPipeline).toArray(),
		]);

		const totalCount = countResult.length > 0 ? countResult[0].total : 0;
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Bookmarked products fetched successfully',
			result: {
				products,
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
	} catch (error) {
		logError('Get all bookmarked products handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get bookmarked products');
	}
};
