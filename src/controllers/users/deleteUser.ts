import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { deactivateWorkspaceUser, UserRemovalError } from '../../utils/userRemoval';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Remove a user from the workspace (soft deactivation).
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('User ID is required');
		}

		const objectIdValidation = validateAllObjectIds({ id: event.pathParameters.id });
		if (objectIdValidation) return objectIdValidation;

		if (event.pathParameters.id === context.userId.toString()) {
			return ResponseWrapper.badRequest(
				'You cannot remove your own user account. Please contact another workspace admin.',
			);
		}

		let targetUserId: ObjectId;
		try {
			targetUserId = new ObjectId(event.pathParameters.id);
		} catch {
			return ResponseWrapper.badRequest('Invalid user ID');
		}

		const deactivatedUser = await deactivateWorkspaceUser({
			targetUserId,
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			auth: auth.payload,
		});

		await recordAuditEvent({
			workspaceId: context.workspaceId.toString(),
			scope: { type: 'workspace', id: context.workspaceId.toString() },
			entity: { type: 'user', id: event.pathParameters.id },
			action: 'delete',
			eventKey: 'member.removed',
			visibility: 'admin',
			where: { module: 'users' },
			auth: auth.payload,
			meta: { memberName: deactivatedUser.name, memberEmail: deactivatedUser.email },
		});

		return ResponseWrapper.success({
			message: 'User removed from workspace successfully',
			user: deactivatedUser,
		});
	} catch (err) {
		if (err instanceof UserRemovalError) {
			if (err.code === 'not_found') {
				return ResponseWrapper.notFound(err.message);
			}
			return ResponseWrapper.badRequest(err.message);
		}

		logError('Remove user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to remove user');
	}
});
