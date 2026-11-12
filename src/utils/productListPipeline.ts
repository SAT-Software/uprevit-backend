import { APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from './responseWrapper';
import { escapeRegex } from './regex';
import { buildLegacyAuditLookupStage, PRODUCT_ACTIVITY_UPDATE_ACTIONS } from './auditLogV2Aggregation';
import { productSummaryProjection } from './productLifecycle';
import { buildListFiltersMatch, ListFilter, ListFilterField } from './listQuery';
import { productTeamLookupStages } from './productAccess';

export const PRODUCT_LIST_MAX_FILTER_LENGTH = 200;

export const PRODUCT_LIST_SORT_FIELDS = [
	'product_name',
	'product_plan_number',
	'product_description',
	'project_name',
	'department_name',
	'version',
	'status',
	'target_date',
	'complete_count',
	'owner_name',
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

export const PRODUCT_ACTIVE_FILTER_FIELDS: Record<string, ListFilterField> = {
	product_name: { path: 'product_name', type: 'text' },
	product_plan_number: { path: 'product_plan_number', type: 'text' },
	project_name: { path: 'project_name', type: 'text' },
	department_name: { path: 'department_name', type: 'text' },
	status: { path: 'status', type: 'text' },
	version: { path: 'version', type: 'number' },
	complete_count: { path: 'complete_count', type: 'number' },
	progress: { path: 'complete_count', type: 'number' },
	owner_name: { path: 'owner_name', type: 'text' },
	createdBy: { path: 'createdBy', type: 'text' },
	createdOn: { path: 'createdOn', type: 'date' },
	modifiedBy: { path: 'modifiedBy', type: 'text' },
	modifiedOn: { path: 'modifiedOn', type: 'date' },
};

export const PRODUCT_ARCHIVE_FILTER_FIELDS: Record<string, ListFilterField> = {
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
 * Free-text product search across name, plan number and description, matched literally.
 * @param {string} filterParam Raw `filter` query value.
 * @return {{ error?: APIGatewayProxyResult, or?: Record<string, unknown>[] }} The `$or` clause, or a 400 when too long.
 */
export const buildProductSearchOr = (
	filterParam?: string,
): { error?: APIGatewayProxyResult; or?: Record<string, unknown>[] } => {
	if (!filterParam) return {};
	if (filterParam.length > PRODUCT_LIST_MAX_FILTER_LENGTH) {
		return { error: ResponseWrapper.badRequest(`filter must not exceed ${PRODUCT_LIST_MAX_FILTER_LENGTH} characters.`) };
	}

	const pattern = escapeRegex(filterParam);
	return {
		or: ['product_name', 'product_plan_number', 'product_description'].map((field) => ({
			[field]: { $regex: pattern, $options: 'i' },
		})),
	};
};

type ProductListPipelineInput = {
	match: Record<string, unknown>;
	isArchiveOnlyStatus: boolean;
	filters: ListFilter[];
	sort: string;
	order: 'asc' | 'desc';
	skip: number;
	limit: number;
};

/**
 * Shared products/bookmarks list pipeline ending in one `$facet` with `rows` and `total`.
 * @param {ProductListPipelineInput} input Base match, status mode, list filters, sort and page window.
 * @return {{ error?: APIGatewayProxyResult, pipeline?: any[] }} The aggregation pipeline, or a 400 for invalid filters.
 */
export const buildProductListPipeline = ({
	match,
	isArchiveOnlyStatus,
	filters,
	sort,
	order,
	skip,
	limit,
}: ProductListPipelineInput): { error?: APIGatewayProxyResult; pipeline?: any[] } => {
	const filtersMatch = buildListFiltersMatch(
		filters,
		isArchiveOnlyStatus ? PRODUCT_ARCHIVE_FILTER_FIELDS : PRODUCT_ACTIVE_FILTER_FIELDS,
	);
	if (filtersMatch.error) return { error: filtersMatch.error };

	const pipeline: any[] = [
		{ $match: match },
		{ $project: productSummaryProjection },
		buildLegacyAuditLookupStage(
			isArchiveOnlyStatus
				? { scopeType: 'product', mode: 'archive' }
				: { scopeType: 'product', updateActions: PRODUCT_ACTIVITY_UPDATE_ACTIONS },
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
		...productTeamLookupStages,
		{
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
		},
		{
			$addFields: {
				createdBy: '$createdAudit.actionBy',
				createdOn: '$createdAudit.actionAt',
				modifiedBy: '$modifiedAudit.actionBy',
				modifiedOn: '$modifiedAudit.actionAt',
				archivedBy: '$actionBy',
				archivedOn: '$actionAt',
			},
		},
	];

	if (filtersMatch.match) pipeline.push({ $match: filtersMatch.match });

	pipeline.push({
		$facet: {
			rows: [{ $sort: { [sort]: order === 'desc' ? -1 : 1 } }, { $skip: skip }, { $limit: limit }],
			total: [{ $count: 'total' }],
		},
	});

	return { pipeline };
};
