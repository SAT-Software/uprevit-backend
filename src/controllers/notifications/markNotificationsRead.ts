import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { NOTIFICATIONS_COLLECTION, type Notification } from '../../models/notification';
import { getDb } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { requireTenantContext } from '../../utils/tenantContext';

/**
 * Marks the caller's notifications as read, either the given `ids` or `all: true`.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
		const input = JSON.parse(event.body);
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			return ResponseWrapper.badRequest('Request body must be a JSON object');
		}

		const all = input.all === true;
		const ids: unknown[] = Array.isArray(input.ids) ? input.ids : [];
		if (!all && (ids.length === 0 || ids.length > 100 || !ids.every((id) => typeof id === 'string' && ObjectId.isValid(id)))) {
			return ResponseWrapper.badRequest('Provide up to 100 valid notification ids, or all: true');
		}

		const db = await getDb();
		const notifications = db.collection<Notification>(NOTIFICATIONS_COLLECTION);
		const filter = { workspaceId: context.workspaceId, userId: context.userId };

		await notifications.updateMany(
			{ ...filter, readAt: null, ...(all ? {} : { _id: { $in: ids.map((id) => new ObjectId(id as string)) } }) },
			{ $set: { readAt: new Date() } },
		);
		const unreadCount = await notifications.countDocuments({ ...filter, readAt: null });

		return ResponseWrapper.success({ message: 'Notifications marked as read', result: { unreadCount } });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Request body must be valid JSON');
		logError('Mark notifications read handler failed', err);
		return ResponseWrapper.internalServerError('Failed to mark notifications as read');
	}
};
