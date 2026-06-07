import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
	USAGE_ADJUSTMENTS_COLLECTION,
	type BillingUsageMetric,
	type UsageAdjustment,
	type UsageUnit,
} from '../../models/billing';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { resolveBillingPeriod } from '../../utils/billing/billingPeriod';
import { recordUsageEvent } from '../../utils/billing/usageRecording';
import { serializeUsageAdjustment } from '../../utils/billing/serializers';

const METRICS: BillingUsageMetric[] = ['completed_export', 'upload_bytes'];

/**
 * Creates a platform usage adjustment and records a matching usage event.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Usage adjustment created payload
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

		const { periodStart, periodEnd } = resolveBillingPeriod(account);
		const unit: UsageUnit = input.metric === 'upload_bytes' ? 'bytes' : 'count';
		const now = new Date();
		const { operator } = operatorResult.context;

		const adjustment: UsageAdjustment = {
			workspaceId: workspaceObjectId,
			billingAccountId: account._id,
			metric: input.metric,
			quantityDelta: input.quantityDelta,
			unit,
			billingPeriodStart: periodStart,
			billingPeriodEnd: periodEnd,
			createdByPlatformAdminId: operator._id!,
			createdAt: now,
		};

		const insertResult = await db.collection<UsageAdjustment>(USAGE_ADJUSTMENTS_COLLECTION).insertOne(adjustment);
		const adjustmentId = insertResult.insertedId;

		await recordUsageEvent({
			workspaceId: workspaceObjectId,
			billingAccountId: account._id,
			metric: input.metric,
			quantity: input.quantityDelta,
			unit,
			source: 'platform_adjustment',
			sourceId: adjustmentId.toString(),
			idempotencyKey: `adjustment:${adjustmentId.toString()}`,
			occurredAt: now,
			billingPeriodStart: periodStart,
			billingPeriodEnd: periodEnd,
		});

		const { auth } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'usage.adjustment.create',
			targetType: 'usage_event',
			workspaceId: workspaceObjectId,
			entityId: adjustmentId.toString(),
			summary: `Created usage adjustment for ${workspace.workspaceName}`,
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.created({
			message: 'Usage adjustment created',
			data: serializeUsageAdjustment({ ...adjustment, _id: adjustmentId }),
		});
	} catch (error) {
		logError('Platform admin create usage adjustment failed', error);
		return ResponseWrapper.internalServerError('Failed to create usage adjustment');
	}
};
