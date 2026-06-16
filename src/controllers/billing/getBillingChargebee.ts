import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { buildChargebeeBillingDetail } from '../../utils/billing/chargebeeBillingDetail';

/**
 * Returns mirrored Chargebee profile and on-demand invoices for the Billing tab.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Chargebee billing payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event, { allowAccessFrozen: true });
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		const account = await getBillingAccountByWorkspaceId(context.workspaceId);
		if (!account) {
			return ResponseWrapper.notFound('Billing account not found');
		}

		const detail = await buildChargebeeBillingDetail(account);

		return ResponseWrapper.success({
			message: 'Chargebee billing retrieved',
			data: detail,
		});
	} catch (error) {
		logError('Get billing chargebee failed', error);
		return ResponseWrapper.internalServerError('Failed to load billing information');
	}
};
