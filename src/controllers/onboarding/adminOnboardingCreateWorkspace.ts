import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getDb, withTransaction } from "../../utils/db";
import type { Workspace } from "../../models/workspace";
import { AuditLogAction } from "../../models/auditLog";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { validateMissingFields } from "../../utils/validationUtils";
import { authenticateWithRole } from "../../utils/authUtils";
import { User } from "../../models/user";
import { AdminGetUserCommand, AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { headUploadObject, isTenantUploadKeyAllowed, isWorkspaceAssetAvailable, movePendingWorkspaceAssetToWorkspace, normalizePersistedAssetReference } from '../../utils/s3-storage';
import { createBillingAccountForWorkspace } from '../../utils/billing/billingAccounts';
import { assertSeatActivationAllowed } from '../../utils/billing/enforcement';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { MongoServerError, ObjectId } from 'mongodb';
import { withTelemetry } from '../../utils/telemetry';

type WorkspaceOnboarding = {
	_id: string;
	workspaceId: ObjectId;
	userId: ObjectId;
	completed: boolean;
};

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

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Ensure caller is admin
		const auth = await authenticateWithRole(event, 'admin');
		if (!auth.isValid) return auth.error;

		const { sub: cognitoSub, username } = auth.payload;
		if (!cognitoSub || !username) return ResponseWrapper.forbidden('Unable to resolve signed-in identity');

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
		let input;
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}
		if (!input || typeof input !== 'object' || Array.isArray(input)) return ResponseWrapper.badRequest('Invalid request body');

		const caller = await cognito.send(new AdminGetUserCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: username,
		}));
		const attributes = new Map((caller.UserAttributes ?? []).map(attribute => [attribute.Name, attribute.Value ?? '']));
		const normalizedEmail = (attributes.get('email') ?? '').trim().toLowerCase();
		if (!caller.Enabled || attributes.get('sub') !== cognitoSub || attributes.get('email_verified') !== 'true' || !normalizedEmail) {
			return ResponseWrapper.forbidden('A verified signed-in email is required');
		}
		if (input.email !== undefined && (typeof input.email !== 'string' || input.email.trim().toLowerCase() !== normalizedEmail)) {
			return ResponseWrapper.badRequest('Email must match the signed-in account');
		}

		const validationResult = validateMissingFields({ workspaceName: input.workspaceName, companyName: input.companyName });
		if (validationResult) return validationResult;

		const db = await getDb();
		const onboardings = db.collection<WorkspaceOnboarding>('workspaceOnboarding');
		const pending = await onboardings.findOne({ _id: cognitoSub });
		const existingUser = await db.collection<User>('users').findOne({ $or: [{ cognitoSub }, { email: normalizedEmail }] });
		const canResume = pending && existingUser?._id.equals(pending.userId)
			&& existingUser.workspaceId?.equals(pending.workspaceId) && existingUser.cognitoSub === cognitoSub
			&& existingUser.email === normalizedEmail && ['inactive', 'active'].includes(existingUser.status);
		if (pending?.completed || (pending && !canResume) || (existingUser && !pending)
			|| (attributes.get('custom:workspaceId') && attributes.get('custom:workspaceId') !== pending?.workspaceId.toString())) {
			return ResponseWrapper.conflict('This account is already associated with a workspace');
		}

		const adminName = resolveAdminName(input.name, normalizedEmail);
		const normalizedLogo = normalizePersistedAssetReference(input.logo, '');
		const onboarding = pending ?? { _id: cognitoSub, workspaceId: new ObjectId(), userId: new ObjectId(), completed: false };
		const { workspaceId, userId } = onboarding;
		if (normalizedLogo && !isTenantUploadKeyAllowed(normalizedLogo, { workspaceId, pendingOwnerId: cognitoSub })) {
			return ResponseWrapper.badRequest('Workspace logo must belong to the signed-in account');
		}
		if (!pending && normalizedLogo && !(await headUploadObject(normalizedLogo))) {
			return ResponseWrapper.badRequest('Workspace logo is unavailable. Upload it again or remove it.');
		}

		if (!pending) {
			await withTransaction(async (txDb, session) => {
				if (await txDb.collection<User>('users').findOne({ $or: [{ cognitoSub }, { email: normalizedEmail }] }, { session })) {
					throw new Error('Account membership changed during onboarding');
				}
				await txDb.collection<WorkspaceOnboarding>('workspaceOnboarding').insertOne(onboarding, { session });
				await txDb.collection<Workspace>('workspaces').insertOne({
					_id: workspaceId,
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
					userIds: [userId],
				}, { session });
				await txDb.collection<User>('users').insertOne({
					_id: userId, name: adminName, email: normalizedEmail, userType: 'admin', cognitoSub, workspaceId, status: 'inactive',
				}, { session });
				await txDb.collection('audit_log').insertMany([
					{ entity: 'workspace', entityId: workspaceId.toString(), action: AuditLogAction.CREATE, actionBy: userId.toString(), actionAt: new Date(), active: true },
					{ entity: 'user', entityId: userId.toString(), action: AuditLogAction.CREATE, actionBy: userId.toString(), actionAt: new Date(), active: true },
				], { session });
			});
		}

		await createBillingAccountForWorkspace(workspaceId);

		const storedWorkspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceId });
		if (!storedWorkspace) throw new Error('Incomplete onboarding records');
		const previousLogo = storedWorkspace.logo || '';
		const requestedLogo = input.logo !== undefined ? normalizedLogo : previousLogo;
		if (pending && requestedLogo && !(await isWorkspaceAssetAvailable(requestedLogo, workspaceId.toString()))) {
			return ResponseWrapper.badRequest('Workspace logo is unavailable. Upload it again or remove it.');
		}
		const workspaceLogo = requestedLogo
			? await movePendingWorkspaceAssetToWorkspace(requestedLogo, workspaceId.toString())
			: '';

		if (workspaceLogo !== previousLogo) {
			await db.collection<Workspace>('workspaces').updateOne(
				{ _id: workspaceId },
				{ $set: { logo: workspaceLogo } },
			);
		}
		if (workspaceLogo) {
			const logoObject = await headUploadObject(workspaceLogo);
			if (!logoObject) throw new Error('Workspace logo is unavailable');
			await recordCommittedUploadIfNew({
				workspaceId,
				previousKey: '',
				newKey: workspaceLogo,
				sizeBytes: logoObject.sizeBytes,
				metadata: { assetType: 'workspace_logo' },
			});
		}

		const seatCheck = await assertSeatActivationAllowed(workspaceId, existingUser?.status === 'active' ? 0 : 1);
		if (!seatCheck.allowed) return ResponseWrapper.forbidden(seatCheck.reason);

		// Publish workspace claims only after MongoDB membership is ready.
		await db.collection<User>('users').updateOne({ _id: userId, cognitoSub, workspaceId }, { $set: { status: 'active' } });
		await cognito.send(new AdminUpdateUserAttributesCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: caller.Username || username,
			UserAttributes: [
				{ Name: "custom:userId", Value: userId.toString() },
				{ Name: "custom:workspaceId", Value: workspaceId.toString() },
				{ Name: "custom:status", Value: "active" },
			],
		}));

		await onboardings.updateOne({ _id: cognitoSub }, { $set: { completed: true } });

		return ResponseWrapper.created({
			message: 'Onboarding successful, workspace created',
			workspaceId: workspaceId.toString(),
		});
	} catch (err) {
		if (err instanceof MongoServerError && err.code === 11000) return ResponseWrapper.conflict('Workspace onboarding is already in progress');
		logError('Admin onboarding create workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to complete onboarding');
	}
})
