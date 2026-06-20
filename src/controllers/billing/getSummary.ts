import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { getBillingAccountByWorkspaceId } from '../../utils/billing/billingAccounts';
import { buildBillingSummary } from '../../utils/billing/serializers';
import { getWorkspaceById } from '../../utils/billing/enforcement';
import { serializeWorkspaceFreezes } from '../../utils/billing/serializers';

/**
 * Returns workspace billing summary for workspace admins.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Workspace billing summary payload
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

		const workspace = await getWorkspaceById(context.workspaceId);
		const summary = await buildBillingSummary({
			account,
			workspaceId: context.workspaceId,
		});

		return ResponseWrapper.success({
			message: 'Billing summary retrieved',
			data: {
				...summary,
				freezes: workspace ? serializeWorkspaceFreezes(workspace) : null,
			},
		});
	} catch (error) {
		logError('Get billing summary failed', error);
		return ResponseWrapper.internalServerError('Failed to load billing summary');
	}
};
