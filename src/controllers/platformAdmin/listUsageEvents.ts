import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { USAGE_EVENTS_COLLECTION, type UsageEvent } from '../../models/billing';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { serializeUsageEvent } from '../../utils/billing/serializers';

/**
 * Lists usage events for a workspace.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Paginated usage events payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		const page = Math.max(1, Number.parseInt(event.queryStringParameters?.page ?? '1', 10) || 1);
		const limit = Math.min(50, Math.max(1, Number.parseInt(event.queryStringParameters?.limit ?? '20', 10) || 20));
		const skip = (page - 1) * limit;
		const metric = event.queryStringParameters?.metric;

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const query: Record<string, unknown> = { workspaceId: workspaceObjectId };
		if (metric) query.metric = metric;

		const [events, total] = await Promise.all([
			db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION)
				.find(query)
				.sort({ occurredAt: -1 })
				.skip(skip)
				.limit(limit)
				.toArray(),
			db.collection<UsageEvent>(USAGE_EVENTS_COLLECTION).countDocuments(query),
		]);

		return ResponseWrapper.success({
			message: 'Usage events retrieved',
			data: {
				items: events
					.filter((item): item is UsageEvent & { _id: ObjectId } => Boolean(item._id))
					.map(serializeUsageEvent),
				pagination: {
					page,
					limit,
					total,
					totalPages: Math.max(1, Math.ceil(total / limit)),
				},
			},
		});
	} catch (error) {
		logError('Platform admin list usage events failed', error);
		return ResponseWrapper.internalServerError('Failed to list usage events');
	}
};
