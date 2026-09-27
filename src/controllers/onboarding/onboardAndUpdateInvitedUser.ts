import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
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
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient();

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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

		if (activatingUser) {
			const seatCheck = await assertSeatActivationAllowed(context.workspaceId, 1);
			if (!seatCheck.allowed) return ResponseWrapper.forbidden(seatCheck.reason);
		}

		const profileUpdate = {
			name: input.name,
			profileAvatar: normalizedAvatar,
			designation: input.designation || '',
			location: input.location || '',
			status: 'active' as const,
		};
		const updateResult = await db.collection("users").updateOne(
			{ cognitoSub: context.cognitoSub, workspaceId: context.workspaceId },
			{ $set: profileUpdate }
		);

		if (updateResult.matchedCount === 0) {
			return ResponseWrapper.notFound("User not found or no changes were made.");
		}

		// Undo this activation only if no other operation has changed the user since.
		const rollbackActivation = () => db.collection<User>('users').updateOne(
			{ cognitoSub: context.cognitoSub, workspaceId: context.workspaceId, ...profileUpdate },
			{
				$set: {
					name: existingUser.name,
					profileAvatar: existingUser.profileAvatar ?? '',
					designation: existingUser.designation ?? '',
					location: existingUser.location ?? '',
					status: previousStatus,
				},
			},
		);

		if (activatingUser) {
			const postActivationCheck = await verifySeatLimitAfterActivation(context.workspaceId);
			if (!postActivationCheck.allowed) {
				await rollbackActivation();
				return ResponseWrapper.forbidden(postActivationCheck.reason);
			}
		}

		// Also runs for users who are already active, repairing any earlier MongoDB and Cognito mismatch.
		try {
			await cognito.send(new AdminUpdateUserAttributesCommand({
				UserPoolId: process.env.USER_POOL_ID!,
				Username: existingUser.email,
				UserAttributes: [{ Name: 'custom:status', Value: 'active' }],
			}));
		} catch (error) {
			if (!activatingUser) {
				logError('Failed to sync Cognito status for active user', error);
			} else {
				await rollbackActivation();
				throw error;
			}
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
			previousKey: typeof existingUser?.profileAvatar === 'string' ? existingUser.profileAvatar : '',
			newKey: normalizedAvatar,
			sizeBytes: input.profileAvatarSizeBytes ?? input.sizeBytes,
			metadata: { assetType: 'profile_avatar' },
		});

		return ResponseWrapper.success({ message: "Profile updated successfully." });

	} catch (error) {
		logError('Onboard and update invited user handler failed', error);
		return ResponseWrapper.internalServerError('Failed to update profile');
	}
};
