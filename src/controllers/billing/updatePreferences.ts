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
import { getBillingAccountByWorkspaceId, normalizeLimits } from '../../utils/billing/billingAccounts';
import { serializeBillingAccount } from '../../utils/billing/serializers';

const isEnforcementMode = (value: unknown): value is EnforcementMode =>
	value === 'overage' || value === 'block';

type PreferencesInput = {
	enforcementMode?: unknown;
	exports?: unknown;
	uploadGb?: unknown;
};

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

		let input: PreferencesInput;
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const hasEnforcementMode = input.enforcementMode !== undefined;
		const hasExports = input.exports !== undefined;
		const hasUploadGb = input.uploadGb !== undefined;

		if (!hasEnforcementMode && !hasExports && !hasUploadGb) {
			return ResponseWrapper.badRequest('At least one preference field is required');
		}

		if (hasEnforcementMode && !isEnforcementMode(input.enforcementMode)) {
			return ResponseWrapper.badRequest("enforcementMode must be 'overage' or 'block'");
		}

		if (hasExports) {
			if (typeof input.exports !== 'number' || !Number.isFinite(input.exports) || input.exports < 0) {
				return ResponseWrapper.badRequest('exports must be a non-negative number');
			}
			if (!Number.isInteger(input.exports)) {
				return ResponseWrapper.badRequest('exports must be a whole number');
			}
		}

		if (hasUploadGb) {
			if (typeof input.uploadGb !== 'number' || !Number.isFinite(input.uploadGb) || input.uploadGb < 0) {
				return ResponseWrapper.badRequest('uploadGb must be a non-negative number');
			}
		}

		const account = await getBillingAccountByWorkspaceId(context.workspaceId);
		if (!account) return ResponseWrapper.notFound('Billing account not found');

		const limits = normalizeLimits(account);
		if (hasEnforcementMode) limits.enforcementMode = input.enforcementMode as EnforcementMode;
		if (hasExports) limits.exports = input.exports as number;
		if (hasUploadGb) limits.uploadGb = input.uploadGb as number;

		const now = new Date();
		const db = await getDb();
		const updated = await db.collection(BILLING_ACCOUNTS_COLLECTION).findOneAndUpdate(
			{ _id: account._id },
			{
				$set: {
					limits,
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
