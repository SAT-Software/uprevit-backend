import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { NOTIFICATIONS_COLLECTION, type Notification } from '../../models/notification';
import { getDb } from '../../utils/db';
import { parseListQuery } from '../../utils/listQuery';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { requireTenantContext } from '../../utils/tenantContext';

/**
 * Lists the caller's notifications, newest first, with their unread count. `unread=true` lists only unread ones.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const listQuery = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ['createdAt'],
			defaultSort: 'createdAt',
			defaultOrder: 'desc',
		});
		if (listQuery.error) return listQuery.error;
		const { page, limit, skip, order } = listQuery.value!;
		const direction = order === 'asc' ? 1 : -1;

		const db = await getDb();
		const notifications = db.collection<Notification>(NOTIFICATIONS_COLLECTION);
		const filter = { workspaceId: context.workspaceId, userId: context.userId };
		const listFilter = event.queryStringParameters?.unread === 'true' ? { ...filter, readAt: null } : filter;

		const [items, totalCount, unreadCount] = await Promise.all([
			notifications.find(listFilter).sort({ createdAt: direction, _id: direction }).skip(skip).limit(limit).toArray(),
			notifications.countDocuments(listFilter),
			notifications.countDocuments({ ...filter, readAt: null }),
		]);
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Notifications fetched successfully',
			result: {
				notifications: items,
				unreadCount,
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
		logError('Get notifications handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get notifications');
	}
};
