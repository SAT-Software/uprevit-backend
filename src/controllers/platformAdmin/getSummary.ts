import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { BILLING_ACCOUNTS_COLLECTION } from '../../models/billing';

/**
 * Returns platform-wide dashboard summary counts.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Platform summary payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const db = await getDb();

		const [
			totalWorkspaces,
			activeUsers,
			invitedUsers,
			workspaceAdmins,
			billingAccounts,
			pastDueWorkspaces,
			meteringEnabledWorkspaces,
		] = await Promise.all([
			db.collection('workspaces').countDocuments({}),
			db.collection('users').countDocuments({ status: 'active', workspaceId: { $ne: null } }),
			db.collection('users').countDocuments({ status: 'invited', workspaceId: { $ne: null } }),
			db.collection('users').countDocuments({ userType: 'admin', workspaceId: { $ne: null } }),
			db.collection(BILLING_ACCOUNTS_COLLECTION).countDocuments({}),
			db.collection(BILLING_ACCOUNTS_COLLECTION).countDocuments({ pastDue: true }),
			db.collection(BILLING_ACCOUNTS_COLLECTION).countDocuments({ 'limits.enabled': true }),
		]);

		return ResponseWrapper.success({
			message: 'Platform summary retrieved',
			data: {
				totalWorkspaces,
				activeUsers,
				invitedUsers,
				workspaceAdmins,
				billing: {
					accountsLinked: billingAccounts,
					pastDueWorkspaces,
					limitsEnabledWorkspaces: meteringEnabledWorkspaces,
					meteringEnabledWorkspaces,
				},
			},
		});
	} catch (error) {
		logError('Platform admin get summary failed', error);
		return ResponseWrapper.internalServerError('Failed to load platform summary');
	}
};
