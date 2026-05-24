import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
import { ObjectId } from 'mongodb';
import { enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';
import { buildListFiltersMatch, ListFilterField, parseListQuery } from '../../utils/listQuery';

const ALLOWED_SORT_FIELDS = ['name', 'email', 'designation', 'location', 'status', 'userType'];

const USER_FILTER_FIELDS: Record<string, ListFilterField> = {
	name: { path: 'name', type: 'text' },
	email: { path: 'email', type: 'text' },
	designation: { path: 'designation', type: 'text' },
	location: { path: 'location', type: 'text' },
	phone: { path: 'phone', type: 'text' },
	status: { path: 'status', type: 'text' },
	userType: { path: 'userType', type: 'text' },
};


export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);

		if (!auth.isValid) {
			return auth.error;
		}

		const listQueryResult = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ALLOWED_SORT_FIELDS,
			defaultSort: 'name',
		});
		if (listQueryResult.error) return listQueryResult.error;

		const { limit, page, skip, sort, order, filters } = listQueryResult.value!;
		const workspaceId = event.queryStringParameters?.workspaceId;

		if (!workspaceId) return ResponseWrapper.badRequest('Valid workspace is required.');
		if (!ObjectId.isValid(workspaceId)) return ResponseWrapper.badRequest('Invalid workspace');

		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sort] = order === 'desc' ? -1 : 1;

		const baseMatch = { workspaceId: new ObjectId(workspaceId) };

		const filtersMatch = buildListFiltersMatch(filters, USER_FILTER_FIELDS);
		if (filtersMatch.error) return filtersMatch.error;

		const queryFilter =
			filtersMatch.match != null
				? { $and: [baseMatch, filtersMatch.match] }
				: baseMatch;

		const db = await getDb();
		const collection = db.collection<User>('users');

		const [users, totalCount] = await Promise.all([
			collection.find(queryFilter).sort(sortObj).skip(skip).limit(limit).toArray(),
			collection.countDocuments(queryFilter),
		]);

		const usersWithSignedAvatars = await enrichUsersWithProfileAvatarUrls(users);
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Users retrieved successfully',
			result: {
				users: usersWithSignedAvatars,
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
		logError('Get users by workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get users');
	}
};
