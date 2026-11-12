import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Create a user
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

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: User = JSON.parse(event.body);

		if (!input.name || !input.email || !input.userType) {
			return ResponseWrapper.badRequest('Missing required fields: name, email, and userType are required');
		}

		if (input.userType !== 'user' && input.userType !== 'approver') {
			return ResponseWrapper.badRequest('User Type must be User or Approver');
		}

		const db = await getDb();
		const normalizedAvatar = normalizePersistedAssetReference(input.profileAvatar, '');

		const user = await db.collection<User>('users').insertOne({
			name: input.name,
			profileAvatar: normalizedAvatar,
			designation: input.designation,
			email: input.email,
			phone: input.phone,
			userType: input.userType,
			location: input.location ?? '',
			cognitoSub: '',
			workspaceId: context.workspaceId,
			status: 'invited',
		});

		await recordAuditEvent({
			workspaceId: context.workspaceId.toString(),
			scope: { type: 'workspace', id: context.workspaceId.toString() },
			entity: { type: 'user', id: user.insertedId.toString() },
			action: 'create',
			eventKey: 'member.invited',
			visibility: 'admin',
			where: { module: 'users' },
			auth: auth.payload,
			meta: { memberName: input.name, memberEmail: input.email },
		});

		await recordCommittedUploadIfNew({
			workspaceId: context.workspaceId,
			previousKey: '',
			newKey: normalizedAvatar,
			sizeBytes: (input as { profileAvatarSizeBytes?: number; sizeBytes?: number }).profileAvatarSizeBytes
				?? (input as { sizeBytes?: number }).sizeBytes,
			metadata: { assetType: 'profile_avatar' },
		});

		return ResponseWrapper.created({
			message: 'User created successfully',
			user: user,
		});

	} catch (err) {
		logError('Create user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create user');
	}
});
