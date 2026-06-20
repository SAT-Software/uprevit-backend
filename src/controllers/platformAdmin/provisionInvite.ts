import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { validateMissingFields } from '../../utils/validationUtils';
import { getDb } from '../../utils/db';
import {
	assertEmailAvailableForProvisionInvite,
	createInvitedCognitoUser,
	InviteEmailConflictError,
	normalizeInviteEmail,
} from '../../utils/platformInviteUtils';

/**
 * Invites a new organization admin with no workspace (create-workspace onboarding).
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Provision invite result
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body);
		const normalizedEmail = typeof input.email === 'string' ? normalizeInviteEmail(input.email) : '';
		if (!normalizedEmail) return ResponseWrapper.badRequest('Email must be a non-empty string');

		const validationResult = validateMissingFields({
			email: normalizedEmail,
			name: input.name,
		});
		if (validationResult) return validationResult;

		const db = await getDb();

		try {
			await assertEmailAvailableForProvisionInvite(db, normalizedEmail);
		} catch (error) {
			if (error instanceof InviteEmailConflictError) {
				return ResponseWrapper.badRequest(error.message);
			}
			throw error;
		}

		const { cognitoSub } = await createInvitedCognitoUser({
			email: normalizedEmail,
			name: input.name.trim(),
			groupName: 'admin',
		});

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'workspace.provision_invite.create',
			targetType: 'user',
			entityId: cognitoSub,
			summary: `Provision invite sent to ${normalizedEmail}`,
			auth: auth.payload,
			operator,
			changes: [{ path: 'email', to: normalizedEmail }],
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.created({
			message: 'Organization admin invite sent',
			data: { email: normalizedEmail, cognitoSub },
		});
	} catch (error) {
		logError('Platform admin provision invite failed', error);
		return ResponseWrapper.internalServerError('Failed to send organization admin invite');
	}
};
