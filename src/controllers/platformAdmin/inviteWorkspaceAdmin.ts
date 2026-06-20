import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import { validateMissingFields } from '../../utils/validationUtils';
import { Workspace } from '../../models/workspace';
import { User } from '../../models/user';
import {
	AdminUpdateUserAttributesCommand,
	CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { assertUsageActionAllowed } from '../../utils/billing/enforcement';
import {
	assertEmailAvailableForWorkspaceAdminInvite,
	createInvitedCognitoUser,
	deleteCognitoInviteUser,
	InviteEmailConflictError,
	normalizeInviteEmail,
} from '../../utils/platformInviteUtils';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Invites a workspace admin to an existing workspace.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Workspace admin invite result
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body);
		const normalizedEmail = typeof input.email === 'string' ? normalizeInviteEmail(input.email) : '';
		if (!normalizedEmail) return ResponseWrapper.badRequest('Email must be a non-empty string');

		const validationResult = validateMissingFields({
			email: normalizedEmail,
			name: input.name,
		});
		if (validationResult) return validationResult;

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();

		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const inviteCheck = await assertUsageActionAllowed(workspaceObjectId, 'invite');
		if (!inviteCheck.allowed) return ResponseWrapper.forbidden(inviteCheck.reason);

		try {
			await assertEmailAvailableForWorkspaceAdminInvite(db, normalizedEmail, workspaceObjectId);
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

		const newUserDoc: User = {
			email: normalizedEmail,
			name: input.name.trim(),
			cognitoSub,
			workspaceId: workspaceObjectId,
			userType: 'admin',
			status: 'invited',
		};

		let userResult;
		try {
			userResult = await db.collection<User>('users').insertOne(newUserDoc);
			await db.collection<Workspace>('workspaces').updateOne(
				{ _id: workspaceObjectId },
				{ $push: { userIds: userResult.insertedId } },
			);
		} catch (dbError) {
			await deleteCognitoInviteUser(normalizedEmail);
			throw dbError;
		}

		const dbUserId = userResult.insertedId.toString();

		await cognito.send(new AdminUpdateUserAttributesCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: normalizedEmail,
			UserAttributes: [
				{ Name: 'custom:userId', Value: dbUserId },
				{ Name: 'custom:workspaceId', Value: workspaceObjectId.toString() },
				{ Name: 'custom:status', Value: 'invited' },
			],
		}));

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'workspace_admin.invite.create',
			targetType: 'workspace',
			workspaceId: workspaceObjectId,
			entityId: dbUserId,
			summary: `Workspace admin invite sent to ${normalizedEmail}`,
			auth: auth.payload,
			operator,
			changes: [{ path: 'email', to: normalizedEmail }],
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.created({
			message: 'Workspace admin invite sent',
			data: { email: normalizedEmail, userId: dbUserId },
		});
	} catch (error) {
		logError('Platform admin workspace admin invite failed', error);
		return ResponseWrapper.internalServerError('Failed to send workspace admin invite');
	}
};
