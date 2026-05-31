import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getDb } from "../../utils/db";
import type { Workspace } from "../../models/workspace";
import { AuditLogAction } from "../../models/auditLog";
import { updateAuditLog } from "../../utils/auditLog";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { validateMissingFields } from "../../utils/validationUtils";
import { authenticateWithRole } from "../../utils/authUtils";
import { User } from "../../models/user";
import { AdminAddUserToGroupCommand, AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { movePendingWorkspaceAssetToWorkspace, normalizePersistedAssetReference } from '../../utils/s3-storage';

const cognito = new CognitoIdentityProviderClient();

const resolveAdminName = (name: unknown, email: string): string => {
	const trimmedName = typeof name === 'string' ? name.trim() : '';
	if (trimmedName && trimmedName.toLowerCase() !== 'test') return trimmedName;

	return email.split('@')[0].trim();
};

/**
 * Platform provisioning: onboarding flow that creates a new workspace and binds
 * the authenticated admin user to it.
 *
 * Not tenant-scoped to an existing workspace — creates a new tenant. Same
 * platform-role caveat as {@link createWorkspace}; do not treat Cognito `admin`
 * as authorization to mutate arbitrary workspaces.
 *
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Ensure caller is admin
		const auth = await authenticateWithRole(event, 'admin');
		if (!auth.isValid) return auth.error;

		const cognitoSub = auth.payload.sub

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');

		const normalizedEmail = typeof input.email === 'string' ? input.email.trim().toLowerCase() : null;
		if (!normalizedEmail) return ResponseWrapper.badRequest('Email must be a non-empty string');

		const validationResult = validateMissingFields({
			workspaceName: input.workspaceName,
			companyName: input.companyName,
			email: normalizedEmail,
		});
		if (validationResult) return validationResult;

		const db = await getDb();
		const adminName = resolveAdminName(input.name, normalizedEmail);
		const normalizedLogo = normalizePersistedAssetReference(input.logo, '');

		const workspace = await db.collection<Workspace>('workspaces').insertOne({
			workspaceName: input.workspaceName,
			companyName: input.companyName,
			description: input.description || '',
			logo: normalizedLogo,
			plan: input.plan || '',
			planName: input.planName || '',
			planId: input.planId || '',
			planStart: input.planStart ? new Date(input.planStart) : null,
			planEnd: input.planEnd ? new Date(input.planEnd) : null,
			cost: input.cost || 0,
			userIds: [],
		});

		const workspaceId = workspace.insertedId

		const workspaceLogo = normalizedLogo
			? await movePendingWorkspaceAssetToWorkspace(normalizedLogo, workspaceId.toString())
			: '';

		if (workspaceLogo !== normalizedLogo) {
			await db.collection<Workspace>('workspaces').updateOne(
				{ _id: workspaceId },
				{ $set: { logo: workspaceLogo } },
			);
		}

		await updateAuditLog({
			entity: 'workspace',
			entityId: workspaceId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString() || auth.payload.sub || 'system',
			actionAt: new Date(),
			active: true,
		});

		const user = await db.collection<User>('users').insertOne({
			name: adminName,
			email: normalizedEmail,
			userType: 'admin',
			cognitoSub: cognitoSub,
			workspaceId: workspaceId,
			status: 'active',
		});

		const userId = user.insertedId

		await db.collection<Workspace>('workspaces').updateOne(
			{ _id: workspaceId },
			{ $push: { "userIds": userId } }
		)
		
		await updateAuditLog({
			entity: 'user',
			entityId: user.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: userId.toString(),
			actionAt: new Date(),
			active: true,
		});

		await cognito.send(new AdminUpdateUserAttributesCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: normalizedEmail,
			UserAttributes: [
				{ Name: "custom:userId", Value: userId.toString() },
				{ Name: "custom:workspaceId", Value: workspaceId.toString() },
				{ Name: "custom:status", Value: "active" },
			],
		}));

		await cognito.send(new AdminAddUserToGroupCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: normalizedEmail,
			GroupName: "admin",
		}));
		

		return ResponseWrapper.created({
			message: 'Onboarding successful, workspace created',
			workspaceId: workspaceId.toString(),
		});
	} catch (err) {
		logError('Admin onboarding create workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to complete onboarding');
	}
}
