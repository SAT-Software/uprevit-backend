import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateMissingFields } from '../../utils/validationUtils';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';

/**
 * Update a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: User = JSON.parse(event.body);

		const missingFields = validateMissingFields({
			name: input.name,
			email: input.email,
		});

		if (missingFields) return missingFields;

		const db = await getDb();

		const userRecord: User | null = await db.collection<User>('users').findOne({
			email: input.email,
			workspaceId: context.workspaceId,
		});

		if (!userRecord?._id) {
			return ResponseWrapper.notFound('User not found');
		}

		const isSelfUpdate = userRecord.cognitoSub === context.cognitoSub;
		const canManageUsers = isWorkspaceAdmin(context.cognitoGroups);

		if (!isSelfUpdate && !canManageUsers) {
			return ResponseWrapper.forbidden('You are not authorized to update this user');
		}

		const normalizedAvatar = normalizePersistedAssetReference(
			input.profileAvatar,
			userRecord.profileAvatar ?? '',
		);

		const user = await db.collection<User>('users').updateOne(
			{
				_id: new ObjectId(userRecord._id),
				workspaceId: context.workspaceId,
			},
			{
				$set: {
					name: input.name,
					profileAvatar: normalizedAvatar,
					email: input.email,
					designation: input.designation || '',
					phone: input.phone,
					location: input.location || '',
				},
			},
		);

		const auditRecord: AuditLog = {
			entity: 'user',
			entityId: (userRecord._id as ObjectId).toString(),
			action: AuditLogAction.UPDATE,
			actionBy: context.userId.toString(),
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		await recordCommittedUploadIfNew({
			workspaceId: context.workspaceId,
			previousKey: userRecord.profileAvatar,
			newKey: normalizedAvatar,
			sizeBytes: (input as { profileAvatarSizeBytes?: number; sizeBytes?: number }).profileAvatarSizeBytes
				?? (input as { sizeBytes?: number }).sizeBytes,
			metadata: { assetType: 'profile_avatar' },
		});

		return ResponseWrapper.success({
			message: 'User updated successfully',
			user: user,
		});

	} catch (err) {
		logError('Update user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update user');
	}
};
