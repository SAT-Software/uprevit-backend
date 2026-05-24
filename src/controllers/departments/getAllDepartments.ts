import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Department } from '../../models/department';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';
import { enrichDepartmentsWithImageUrls, enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';
import { buildListFiltersMatch, ListFilterField, parseListQuery } from '../../utils/listQuery';

const ALLOWED_SORT_FIELDS = [
	'department_name',
	'department_description',
	'manager',
	'users',
	'actionBy',
	'actionAt',
	'_id',
];

const DEPARTMENT_SORT_FIELD_MAP: Record<string, string> = {
	users: 'userCount',
};

const DEPARTMENT_FILTER_FIELDS: Record<string, ListFilterField> = {
	department_name: { path: 'department_name', type: 'text' },
	department_description: { path: 'department_description', type: 'text' },
	manager: { path: 'manager', type: 'text' },
	actionBy: { path: 'actionBy', type: 'text' },
	actionAt: { path: 'actionAt', type: 'date' },
	lastChangedBy: { path: 'actionBy', type: 'text' },
	lastChangedOn: { path: 'actionAt', type: 'date' },
	archivedBy: { path: 'actionBy', type: 'text' },
	archivedOn: { path: 'actionAt', type: 'date' },
};

type DepartmentUser = {
	_id: ObjectId;
	name: string;
	email: string;
	profileAvatar?: string;
};

type DepartmentWithUsers = Omit<Department, 'users'> & {
	users?: DepartmentUser[];
	auditLogs?: unknown[];
	actionAt?: Date;
};

/**
 * Get all departments
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) {
			return auth.error;
		}

		const db = await getDb();

		const listQueryResult = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ALLOWED_SORT_FIELDS,
			defaultSort: 'department_name',
		});
		if (listQueryResult.error) return listQueryResult.error;

		const { limit, page, skip, sort, order, filters } = listQueryResult.value!;
		const workspaceId = event.queryStringParameters?.workspaceId;

		if (!workspaceId) return ResponseWrapper.badRequest('Workspace ID is required.');
		if (!ObjectId.isValid(workspaceId)) return ResponseWrapper.badRequest('Invalid workspaceId');

		const isArchiveParam = event.queryStringParameters?.isArchive;
		let isArchive = false;

		if (isArchiveParam !== undefined) {
			if (isArchiveParam !== 'true' && isArchiveParam !== 'false') {
				return ResponseWrapper.badRequest('isArchive parameter must be true or false');
			}
			isArchive = isArchiveParam.toLowerCase() === 'true';
		}

		const sortField = DEPARTMENT_SORT_FIELD_MAP[sort] ?? sort;
		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sortField] = order === 'desc' ? -1 : 1;

		const filter = isArchive
			? { isArchived: true, workspace_id: new ObjectId(workspaceId) }
			: { isArchived: { $ne: true }, workspace_id: new ObjectId(workspaceId) };

		const pipeline = [
			{ $match: filter },
			{
				$lookup: {
					from: 'users',
					localField: 'users',
					foreignField: '_id',
					pipeline: [
						{
							$project: {
								_id: 1,
								name: 1,
								email: 1,
								profileAvatar: 1,
							},
						},
					],
					as: 'users',
				},
			},
			isArchive
				? buildLegacyAuditLookupStage({ scopeType: 'department', mode: 'archive' })
				: buildLegacyAuditLookupStage({ scopeType: 'department', updateActions: ['update', 'restore'] }),
			{
				$addFields: {
					actionBy: { $arrayElemAt: ['$auditLogs.actionBy', 0] },
					actionAt: { $arrayElemAt: ['$auditLogs.actionAt', 0] },
					userCount: { $size: { $ifNull: ['$users', []] } },
				},
			},
		];

		const filtersMatch = buildListFiltersMatch(filters, DEPARTMENT_FILTER_FIELDS);
		if (filtersMatch.error) return filtersMatch.error;
		if (filtersMatch.match) pipeline.push({ $match: filtersMatch.match });

		const [departments, countResult] = await Promise.all([
			db.collection<Department>('departments')
				.aggregate<DepartmentWithUsers>(pipeline.concat([{ $sort: sortObj }, { $skip: skip }, { $limit: limit }]))
				.toArray(),
			db.collection<Department>('departments')
				.aggregate<{ total: number }>(pipeline.concat({ $count: 'total' }))
				.toArray(),
		]);
		const totalCount = countResult.length > 0 ? countResult[0].total : 0;

		const departmentsWithSignedAvatars = await Promise.all(
			departments.map(async (department) => {
				if (!department.users?.length) return department;

				const usersWithSignedAvatars = await enrichUsersWithProfileAvatarUrls(department.users);

				return {
					...department,
					users: usersWithSignedAvatars,
				};
			}),
		);

		const departmentsWithSignedUrls = await enrichDepartmentsWithImageUrls(departmentsWithSignedAvatars);

		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Departments fetched successfully',
			result: {
				departments: departmentsWithSignedUrls,
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
		logError('Get all departments handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get departments');
	}
};
