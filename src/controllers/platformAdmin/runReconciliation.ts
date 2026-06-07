import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { runBillingReconciliation } from '../../utils/billing/reconciliation';

/**
 * Runs billing reconciliation across all workspaces or a single workspace.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Reconciliation run summary payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		let workspaceId: ObjectId | undefined;
		if (event.body) {
			try {
				const input = JSON.parse(event.body) as { workspaceId?: string };
				if (input.workspaceId) {
					if (!ObjectId.isValid(input.workspaceId)) {
						return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
					}
					workspaceId = new ObjectId(input.workspaceId);
				}
			} catch {
				return ResponseWrapper.badRequest('Invalid JSON in request body');
			}
		}

		const results = await runBillingReconciliation({ workspaceId });

		return ResponseWrapper.success({
			message: 'Billing reconciliation completed',
			data: { results },
		});
	} catch (error) {
		logError('Platform admin run reconciliation failed', error);
		return ResponseWrapper.internalServerError('Failed to run billing reconciliation');
	}
};
