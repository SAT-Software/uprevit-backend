import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { syncMemberCognitoGroups } from '../../utils/memberAccess';
import { getDb } from "../../utils/db";
import { requireTenantContext } from "../../utils/tenantContext";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { validateMissingFields } from "../../utils/validationUtils";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";
import type { User } from '../../models/user';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { assertSeatActivationAllowed, verifySeatLimitAfterActivation } from '../../utils/billing/enforcement';
import { seatClassForUserType } from '../../utils/billing/usageRecording';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { withTelemetry } from '../../utils/telemetry';

const cognito = new CognitoIdentityProviderClient();

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const handler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest("Request body is required.");


		const input = JSON.parse(event.body);

		const validationResult = validateMissingFields({ name: input.name });
		if (validationResult) return validationResult;


		const db = await getDb();

		const existingUser = await db.collection<User>('users').findOne({
			cognitoSub: context.cognitoSub,
			workspaceId: context.workspaceId,
		});
		if (!existingUser) return ResponseWrapper.notFound("User not found or no changes were made.");

		const normalizedAvatar = normalizePersistedAssetReference(
			input.profileAvatar,
			typeof existingUser?.profileAvatar === 'string' ? existingUser.profileAvatar : '',
		);

		const previousStatus = existingUser.status;
		const activatingUser = previousStatus !== 'active';
		const seatClass = seatClassForUserType(existingUser.userType);

		if (activatingUser) {
			const seatCheck = await assertSeatActivationAllowed(context.workspaceId, seatClass);
			if (!seatCheck.allowed) return ResponseWrapper.forbidden(seatCheck.reason);
		}

		const updateResult = await db.collection("users").updateOne(
			{ cognitoSub: context.cognitoSub, workspaceId: context.workspaceId },
			{
				$set: {
					name: input.name,
					profileAvatar: normalizedAvatar,
					designation: input.designation || '',
					location: input.location || '',
					status: 'active',
				},
			}
		);

		if (updateResult.matchedCount === 0) {
			return ResponseWrapper.notFound("User not found or no changes were made.");
		}

		if (activatingUser) {
			const postActivationCheck = await verifySeatLimitAfterActivation(context.workspaceId, seatClass);
			if (!postActivationCheck.allowed) {
				await db.collection("users").updateOne(
					{ cognitoSub: context.cognitoSub, workspaceId: context.workspaceId, status: 'active' },
					{ $set: { status: previousStatus } },
				);
				return ResponseWrapper.forbidden(postActivationCheck.reason);
			}
		}

		// Runs on every save so a retry repairs any MongoDB and Cognito status mismatch.
		// A failed sync is not rolled back; the request fails and the user resubmits.
		let cognitoSyncError: unknown;
		try {
			await cognito.send(new AdminUpdateUserAttributesCommand({
				UserPoolId: process.env.USER_POOL_ID!,
				Username: existingUser.email,
				UserAttributes: [{ Name: 'custom:status', Value: 'active' }],
			}));
			await syncMemberCognitoGroups(existingUser.email, {
				userType: existingUser.userType === undefined ? 'user' : existingUser.userType,
				isManager: existingUser.isManager === true,
			});
		} catch (error) {
			cognitoSyncError = error;
		}

		await updateAuditLog({
			entity: 'user',
			entityId: context.userId.toString(),
			action: AuditLogAction.UPDATE,
			actionAt: new Date(),
			active: true,
			actionBy: input.name,
		});

		await recordCommittedUploadIfNew({
			workspaceId: context.workspaceId,
			newKey: normalizedAvatar,
			metadata: { assetType: 'profile_avatar' },
		});

		if (cognitoSyncError) throw cognitoSyncError;

		return ResponseWrapper.success({ message: "Profile updated successfully." });

	} catch (error) {
		logError('Onboard and update invited user handler failed', error);
		return ResponseWrapper.internalServerError('Failed to update profile');
	}
});
