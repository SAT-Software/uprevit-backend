import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext, tenantUserIdFilter } from '../../utils/tenantContext';
import { validateAllObjectIds } from '../../utils/validationUtils';

/**
 * Delete a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('User ID is required');
		}

		const objectIdValidation = validateAllObjectIds({ id: event.pathParameters.id });
		if (objectIdValidation) return objectIdValidation;

		if (event.pathParameters.id === context.userId.toString()) {
			return ResponseWrapper.badRequest('You cannot delete your own user account. Please contact your workspace admin to delete your account.');
		}

		const db = await getDb();

		const user = await db.collection<User>('users').deleteOne(
			tenantUserIdFilter(event.pathParameters.id, context.workspaceId),
		);

		if (user.deletedCount === 0) {
			return ResponseWrapper.notFound('User not found');
		}

		const auditRecord: AuditLog = {
			entity: 'user',
			entityId: (event.pathParameters.id).toString(),
			action: AuditLogAction.DELETE,
			actionBy: context.userId.toString(),
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'User deleted successfully',
			user: user,
		});

	} catch (err) {
		logError('Delete user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to delete user');
	}
};
