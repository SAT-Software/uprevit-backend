import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getDb } from "../../utils/db";
import { requireTenantContext } from "../../utils/tenantContext";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { validateMissingFields } from "../../utils/validationUtils";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { assertSeatActivationAllowed } from '../../utils/billing/enforcement';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';

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

		const existingUser = await db.collection('users').findOne({
			cognitoSub: context.cognitoSub,
			workspaceId: context.workspaceId,
		});

		const normalizedAvatar = normalizePersistedAssetReference(
			input.profileAvatar,
			typeof existingUser?.profileAvatar === 'string' ? existingUser.profileAvatar : '',
		);

		if (existingUser?.status !== 'active') {
			const seatCheck = await assertSeatActivationAllowed(context.workspaceId, 1);
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
