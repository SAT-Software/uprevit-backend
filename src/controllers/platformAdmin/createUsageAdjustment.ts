import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import type { BillingUsageMetric, UsageUnit } from '../../models/billing';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { resolveUsagePeriod } from '../../utils/billing/billingPeriod';
import { recordUsageEvent } from '../../utils/billing/usageRecording';
import { serializeUsageEvent } from '../../utils/billing/serializers';
import {
	buildChargebeeDeduplicationId,
	trySyncUsageEventToChargebee,
} from '../../utils/billing/usageEventChargebeeSync';

const METRICS: BillingUsageMetric[] = ['completed_export', 'upload_bytes'];

/**
 * Creates a platform usage adjustment as a usage event.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Usage event created payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input: { metric?: BillingUsageMetric; quantityDelta?: number };
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		if (!input.metric || !METRICS.includes(input.metric)) {
			return ResponseWrapper.badRequest('Invalid usage metric');
		}
		if (typeof input.quantityDelta !== 'number' || !Number.isFinite(input.quantityDelta) || input.quantityDelta === 0) {
			return ResponseWrapper.badRequest('quantityDelta must be a non-zero number');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const account = await getBillingAccountByWorkspaceId(workspaceObjectId);
		if (!account) return ResponseWrapper.notFound('Billing account not found');

		const { periodStart, periodEnd } = resolveUsagePeriod(account);
		const unit: UsageUnit = input.metric === 'upload_bytes' ? 'bytes' : 'count';
		const now = new Date();
		const { operator } = operatorResult.context;
		const adjustmentId = new ObjectId();

		const idempotencyKey = `adjustment:${adjustmentId.toString()}`;
		const insertedEvent = await recordUsageEvent({
			workspaceId: workspaceObjectId,
			billingAccountId: account._id,
			metric: input.metric,
			quantity: input.quantityDelta,
			unit,
			source: 'platform_adjustment',
			sourceId: adjustmentId.toString(),
			idempotencyKey,
			occurredAt: now,
			billingPeriodStart: periodStart,
			billingPeriodEnd: periodEnd,
			metadata: {
				createdByPlatformAdminId: operator._id?.toString(),
			},
			chargebeeSync: {
				status: 'pending',
				deduplicationId: buildChargebeeDeduplicationId(idempotencyKey),
				attempts: 0,
			},
		});

		if (!insertedEvent?._id) {
			return ResponseWrapper.conflict('Usage adjustment already exists');
		}

		await trySyncUsageEventToChargebee({
			event: insertedEvent as typeof insertedEvent & { _id: ObjectId },
			account,
		});

		const { auth } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'usage.adjustment.create',
			targetType: 'usage_event',
			workspaceId: workspaceObjectId,
			entityId: insertedEvent._id.toString(),
			summary: `Created usage adjustment for ${workspace.workspaceName}`,
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.created({
			message: 'Usage adjustment created',
			data: serializeUsageEvent(insertedEvent as typeof insertedEvent & { _id: ObjectId }),
		});
	} catch (error) {
		logError('Platform admin create usage adjustment failed', error);
		return ResponseWrapper.internalServerError('Failed to create usage adjustment');
	}
};
