import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
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
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
	   
		const auth = await authenticateRequest(event);

		if(!auth.isValid) return auth.error;


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
		const workspaceId = event.queryStringParameters?.workspaceId;
		const projectId = event.queryStringParameters?.projectId;
		const departmentId = event.queryStringParameters?.departmentId;

		// Build filter object
		const filter: any = {};
		let statusValues: string[] | null = null;

		if (workspaceId) {
			if (!ObjectId.isValid(workspaceId)) return ResponseWrapper.badRequest('Invalid workspaceId');
			filter.workspace_id = new ObjectId(workspaceId);
		}

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
			} catch (e) {
				// If parsing fails, treat as single status
				filter.status = statusFilter;
				statusValues = [statusFilter];
			}
		} else {
			// Default status filter
			filter.status = { $in: ['draft', 'submitted'] };
			statusValues = ['draft', 'submitted'];
		}

		const isArchiveOnlyStatus = statusValues?.length === 1 && statusValues[0] === 'archived';

		// General filter parameter for text search
		if (filterParam) {
			filter.$or = [
				{ product_name: { $regex: filterParam, $options: 'i' } },
				{ product_plan_number: { $regex: filterParam, $options: 'i' } },
				{ product_description: { $regex: filterParam, $options: 'i' } },
			];
		}

		// Filter for isLatest
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
					pipeline: [
						{ 
							$project: { department_name: 1 }
						}
					]
				}
			},
			{
				$lookup: {
					from: 'projects',
					localField: 'project_id',
					foreignField: '_id',
					as: 'project',
					pipeline: [
						{ 
							$project: { project_name: 1 }
						}
					]
				}
			}
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

		// Add pagination
		pipeline.push({ $skip: skip });
		pipeline.push({ $limit: limit });

		// Get total count for pagination
		const countPipeline = pipeline.slice(0, -3).concat({ $count: 'total' });

		const [products, countResult] = await Promise.all([
			db.collection<Product>('products').aggregate(pipeline).toArray(),
			db.collection<Product>('products').aggregate(countPipeline).toArray(),
		]);

		const totalCount = countResult.length > 0 ? countResult[0].total : 0;
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Products fetched successfully',
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
	} catch (err) {
		logError('Get all products handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get products');
	}
};
