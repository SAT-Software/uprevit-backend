import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
	type EnforcementMode,
} from '../../models/billing';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { serializeBillingAccount } from '../../utils/billing/serializers';

const isEnforcementMode = (value: unknown): value is EnforcementMode =>
	value === 'overage' || value === 'block';

/**
 * Updates workspace billing preferences allowed for workspace admins.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Billing preferences updated payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input: { enforcementMode?: unknown };
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		if (!isEnforcementMode(input.enforcementMode)) {
			return ResponseWrapper.badRequest("enforcementMode must be 'overage' or 'block'");
		}

		const account = await getBillingAccountByWorkspaceId(context.workspaceId);
		if (!account) return ResponseWrapper.notFound('Billing account not found');

		const now = new Date();
		const db = await getDb();
		const updated = await db.collection(BILLING_ACCOUNTS_COLLECTION).findOneAndUpdate(
			{ _id: account._id },
			{
				$set: {
					'workspacePreferences.enforcementMode': input.enforcementMode,
					updatedAt: now,
				},
			},
			{ returnDocument: 'after' },
		);

		if (!updated) return ResponseWrapper.notFound('Billing account not found');

		return ResponseWrapper.success({
			message: 'Billing preferences updated',
			data: serializeBillingAccount(updated as BillingAccount & { _id: ObjectId }),
		});
	} catch (error) {
		logError('Update billing preferences failed', error);
		return ResponseWrapper.internalServerError('Failed to update billing preferences');
	}
};
