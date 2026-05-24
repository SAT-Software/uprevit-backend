import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Project } from '../../models/project';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';
import { enrichProjectsWithImageUrls, enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';
import { buildListFiltersMatch, ListFilterField, parseListQuery } from '../../utils/listQuery';

const ALLOWED_SORT_FIELDS = [
	'project_number',
	'project_name',
	'project_description',
	'project_manager',
	'users',
	'createdOn',
	'modifiedOn',
	'actionBy',
	'actionAt',
	'_id',
];

const PROJECT_SORT_FIELD_MAP: Record<string, string> = {
	users: 'userCount',
};

const PROJECT_FILTER_FIELDS: Record<string, ListFilterField> = {
	project_name: { path: 'project_name', type: 'text' },
	project_description: { path: 'project_description', type: 'text' },
	project_manager: { path: 'project_manager', type: 'text' },
	actionBy: { path: 'actionBy', type: 'text' },
	actionAt: { path: 'actionAt', type: 'date' },
	lastChangedBy: { path: 'actionBy', type: 'text' },
	lastChangedOn: { path: 'actionAt', type: 'date' },
	archivedBy: { path: 'actionBy', type: 'text' },
	archivedOn: { path: 'actionAt', type: 'date' },
};

type ProjectUser = {
	_id: ObjectId;
	name: string;
	email: string;
	profileAvatar?: string;
};

type ProjectWithUsers = Omit<Project, 'users'> & {
	users?: ProjectUser[];
	auditLogs?: unknown[];
	actionAt?: Date;
};

/**
 * Get all projects
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
			defaultSort: 'actionAt',
			defaultOrder: 'desc',
		});
		if (listQueryResult.error) return listQueryResult.error;

		const { limit, page, skip, sort, order, filters } = listQueryResult.value!;
		const sortField = PROJECT_SORT_FIELD_MAP[sort] ?? sort;
		const workspaceId = event.queryStringParameters?.workspaceId;
		const isArchiveParam = event.queryStringParameters?.isArchive || 'false';
		const departmentId = event.queryStringParameters?.departmentId;

		if (!workspaceId) return ResponseWrapper.badRequest('Workspace ID is required.');
		if (!ObjectId.isValid(workspaceId)) return ResponseWrapper.badRequest('Invalid workspaceId');
		if (departmentId && !ObjectId.isValid(departmentId)) return ResponseWrapper.badRequest('Invalid departmentId');

		// Validate isArchive parameter
		if (isArchiveParam !== 'true' && isArchiveParam !== 'false') {
			return ResponseWrapper.badRequest('isArchive parameter must be true or false');
		}

		// Convert to boolean
		const isArchive = isArchiveParam === 'true';

		// filter based on isArchive parameter
		const filter: Record<string, unknown> = isArchive
			? { isArchived: true, workspace_id: new ObjectId(workspaceId) }
			: { isArchived: { $ne: true }, workspace_id: new ObjectId(workspaceId) };

		if (departmentId) filter.department_id = new ObjectId(departmentId);

		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sortField] = order === 'desc' ? -1 : 1;

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
				? buildLegacyAuditLookupStage({ scopeType: 'project', mode: 'archive' })
				: buildLegacyAuditLookupStage({ scopeType: 'project', updateActions: ['update', 'restore'] }),
			{
				$addFields: {
					actionBy: { $arrayElemAt: ['$auditLogs.actionBy', 0] },
					actionAt: { $arrayElemAt: ['$auditLogs.actionAt', 0] },
					createdAudit: {
						$first: {
							$filter: {
								input: '$auditLogs',
								as: 'auditLog',
								cond: { $eq: ['$$auditLog.action', 'create'] },
							},
						},
					},
					modifiedAudit: {
						$first: {
							$filter: {
								input: '$auditLogs',
								as: 'auditLog',
								cond: { $eq: ['$$auditLog.action', 'update'] },
							},
						},
					},
					userCount: { $size: { $ifNull: ['$users', []] } },
				},
			},
			{
				$addFields: {
					createdOn: '$createdAudit.actionAt',
					modifiedOn: '$modifiedAudit.actionAt',
				},
			},
		];

		const filtersMatch = buildListFiltersMatch(filters, PROJECT_FILTER_FIELDS);
		if (filtersMatch.error) return filtersMatch.error;
		if (filtersMatch.match) pipeline.push({ $match: filtersMatch.match });

		const [projects, countResult] = await Promise.all([
			db.collection<Project>('projects')
				.aggregate<ProjectWithUsers>(pipeline.concat([{ $sort: sortObj }, { $skip: skip }, { $limit: limit }]))
				.toArray(),
			db.collection<Project>('projects').aggregate<{ total: number }>(pipeline.concat({ $count: 'total' })).toArray(),
		]);

		const projectsWithSignedAvatars = await Promise.all(
			projects.map(async (project) => {
				if (!project.users?.length) return project;

				const usersWithSignedAvatars = await enrichUsersWithProfileAvatarUrls(project.users);

				return {
					...project,
					users: usersWithSignedAvatars,
				};
			}),
		);

		const projectsWithSignedUrls = await enrichProjectsWithImageUrls(projectsWithSignedAvatars);

		const totalCount = countResult.length > 0 ? countResult[0].total : 0;
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({message: 'Projects fetched successfully',
			result: {
				projects: projectsWithSignedUrls,
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
		logError('Get all projects handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get projects');
	}
};
