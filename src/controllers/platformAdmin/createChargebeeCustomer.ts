import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { serializeBillingAccount } from '../../utils/billing/serializers';
import { isChargebeeConfigured } from '../../config/chargebeeConfig';
import { createChargebeeCustomer } from '../../utils/billing/chargebeeClient';
import { BILLING_ACCOUNTS_COLLECTION, type BillingAccount } from '../../models/billing';

/**
 * Creates a Chargebee customer and links it to the workspace billing account.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Customer created payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		if (!isChargebeeConfigured()) {
			return ResponseWrapper.badRequest('Chargebee is not configured');
		}

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const account = await getBillingAccountByWorkspaceId(workspaceObjectId);
		if (!account) return ResponseWrapper.notFound('Billing account not found');

		if (account.chargebee?.customerId) {
			return ResponseWrapper.conflict('Chargebee customer is already linked');
		}

		let input: { email?: string } = {};
		if (event.body) {
			try {
				input = JSON.parse(event.body);
			} catch {
				return ResponseWrapper.badRequest('Invalid JSON in request body');
			}
		}

		const customerId = `ws_${workspaceId}`;
		const customer = await createChargebeeCustomer({
			id: customerId,
			company: workspace.workspaceName,
			email: typeof input.email === 'string' ? input.email : undefined,
		});

		const now = new Date();
		await db.collection<BillingAccount>(BILLING_ACCOUNTS_COLLECTION).updateOne(
			{ _id: account._id },
			{
				$set: {
					chargebee: {
						...(account.chargebee ?? {}),
						customerId: customer.id,
						lastSyncedAt: now,
					},
					updatedAt: now,
				},
			},
		);

		const updated = await getBillingAccountByWorkspaceId(workspaceObjectId);
		if (!updated) {
			return ResponseWrapper.internalServerError('Failed to load updated billing account');
		}

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'chargebee.customer.create',
			targetType: 'chargebee_customer',
			workspaceId: workspaceObjectId,
			entityId: customer.id,
			summary: `Created Chargebee customer for ${workspace.workspaceName}`,
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.created({
			message: 'Chargebee customer created',
			data: {
				customerId: customer.id,
				account: serializeBillingAccount(updated),
			},
		});
	} catch (error) {
		logError('Platform admin create Chargebee customer failed', error);
		return ResponseWrapper.internalServerError('Failed to create Chargebee customer');
	}
};
