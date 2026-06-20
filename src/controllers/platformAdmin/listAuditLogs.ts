import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Filter, ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { parseListQuery } from '../../utils/listQuery';
import {
	PLATFORM_AUDIT_ACTIONS,
	PLATFORM_AUDIT_LOGS_COLLECTION,
	PLATFORM_AUDIT_SESSION_ACCESS_ACTION,
	type PlatformAuditAction,
	type PlatformAuditLog,
} from '../../models/platformAuditLog';
import { serializePlatformAuditLog } from '../../utils/platformAdminSerializers';

const ALLOWED_SORT_FIELDS = ['occurredAt', 'action', 'status'];

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lists platform audit logs with optional filters.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Paginated platform audit logs
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const parsed = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ALLOWED_SORT_FIELDS,
			defaultSort: 'occurredAt',
			defaultOrder: 'desc',
		});
		if (parsed.error) return parsed.error;
		const { page, limit, sort, order, skip } = parsed.value!;

		const search = event.queryStringParameters?.search?.trim();
		const workspaceId = event.queryStringParameters?.workspaceId;
		const action = event.queryStringParameters?.action;
		const status = event.queryStringParameters?.status;

		const match: Filter<PlatformAuditLog> = {};

		if (workspaceId) {
			if (!ObjectId.isValid(workspaceId)) {
				return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
			}
			match['target.workspaceId'] = new ObjectId(workspaceId);
		}

		if (action) {
			if (!PLATFORM_AUDIT_ACTIONS.includes(action as PlatformAuditAction)) {
				return ResponseWrapper.badRequest(`action must be one of: ${PLATFORM_AUDIT_ACTIONS.join(', ')}`);
			}
			match.action = action as PlatformAuditAction;
		} else {
			match.action = { $ne: PLATFORM_AUDIT_SESSION_ACCESS_ACTION };
		}

		if (status) {
			if (status !== 'success' && status !== 'failed') {
				return ResponseWrapper.badRequest('status must be success or failed');
			}
			match.status = status;
		}

		if (search) {
			const pattern = escapeRegex(search);
			match.$or = [
				{ summary: { $regex: pattern, $options: 'i' } },
				{ 'actor.email': { $regex: pattern, $options: 'i' } },
				{ 'actor.name': { $regex: pattern, $options: 'i' } },
			];
		}

		const db = await getDb();
		const collection = db.collection<PlatformAuditLog>(PLATFORM_AUDIT_LOGS_COLLECTION);
		const sortDirection = order === 'asc' ? 1 : -1;

		const [items, total] = await Promise.all([
			collection.find(match).sort({ [sort]: sortDirection, _id: -1 }).skip(skip).limit(limit).toArray(),
			collection.countDocuments(match),
		]);

		return ResponseWrapper.success({
			message: 'Platform audit logs retrieved',
			data: {
				items: items.map(serializePlatformAuditLog),
				pagination: {
					page,
					limit,
					total,
					totalPages: Math.max(1, Math.ceil(total / limit)),
				},
			},
		});
	} catch (error) {
		logError('Platform admin list audit logs failed', error);
		return ResponseWrapper.internalServerError('Failed to list platform audit logs');
	}
};
