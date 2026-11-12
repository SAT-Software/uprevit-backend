import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getDb } from "../../utils/db";
import { User } from "../../models/user";
import { ObjectId } from "mongodb";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { validateUserArray } from "../../utils/validationUtils";
import { Workspace } from "../../models/workspace";
import { assertWorkspaceMatch, isWorkspaceAdmin, requireTenantContext } from "../../utils/tenantContext";
import { assertUsageActionAllowed } from "../../utils/billing/enforcement";
import {
	assertEmailAvailableForWorkspaceMemberInvite,
	InviteEmailConflictError,
	normalizeInviteEmail,
} from "../../utils/platformInviteUtils";
import { findInactiveWorkspaceUserByEmail, reactivateWorkspaceUser } from "../../utils/userRemoval";
import { parseAssignableMemberAccess, syncMemberCognitoGroups, type MemberAccess } from "../../utils/memberAccess";
import { withTelemetry } from '../../utils/telemetry';
import { recordAuditEvent } from '../../utils/auditLogV2';

const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1' });

type InviteResult = {
	email: string;
	status: 'Success' | 'Failed' | 'Reactivated';
	reason?: string;
};

/**
 * @param {APIGatewayProxyEvent} event 
 * @return  {Promise<APIGatewayProxyResult>}
 */
export const handler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId) return ResponseWrapper.badRequest("Workspace ID is required in path parameters");

		if (!ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('Invalid workspace ID format. Must be a valid MongoDB ObjectId.');
		}

		const workspaceMismatch = assertWorkspaceMatch(workspaceId, context.workspaceId);
		if (workspaceMismatch) return workspaceMismatch;

		if (!event.body) return ResponseWrapper.badRequest("Request body is required.");

		const users = JSON.parse(event.body);
		const validationError = validateUserArray(users, "users");
		if(validationError) return validationError;

		const parsedAccesses = (users as Array<{ userType?: unknown; isManager?: unknown }>).map((user) => (
			user.userType === undefined && user.isManager === undefined
				? { userType: 'user' as const, isManager: false }
				: parseAssignableMemberAccess(user.userType ?? null, user.isManager ?? false)
		));
		const accessError = parsedAccesses.find((access): access is string => typeof access === 'string');
		if (accessError) return ResponseWrapper.badRequest(accessError);
		const accesses = parsedAccesses as MemberAccess[];

		const inviteCheck = await assertUsageActionAllowed(context.workspaceId, 'invite');
		if (!inviteCheck.allowed) return ResponseWrapper.forbidden(inviteCheck.reason);

		const db = await getDb();
		const workspaceObjectId = context.workspaceId;
		const results: InviteResult[] = [];

		const recordInvite = (entityId: string, eventKey: 'member.invited' | 'member.reactivated', memberName: string, memberEmail: string) =>
			recordAuditEvent({
				workspaceId: workspaceObjectId.toString(),
				scope: { type: 'workspace', id: workspaceObjectId.toString() },
				entity: { type: 'user', id: entityId },
				action: 'create',
				eventKey,
				visibility: 'admin',
				where: { module: 'users' },
				auth: auth.payload,
				meta: { memberName, memberEmail },
			});

		for (const [index, user] of users.entries()) {
			const { email, name } = user;
			const access = accesses[index];
			const normalizedEmail = normalizeInviteEmail(email);
			try {
				await assertEmailAvailableForWorkspaceMemberInvite(db, normalizedEmail, workspaceObjectId);

				const inactiveUser = await findInactiveWorkspaceUserByEmail(db, normalizedEmail, workspaceObjectId);
				if (inactiveUser) {
					await reactivateWorkspaceUser({
						email: normalizedEmail,
						name,
						workspaceId: workspaceObjectId,
						actorUserId: context.userId,
						access: inactiveUser.userType === 'admin' ? { ...access, userType: 'admin' } : access,
					});
					await recordInvite(inactiveUser._id!.toString(), 'member.reactivated', name, normalizedEmail);
					results.push({ email: normalizedEmail, status: 'Reactivated' });
					continue;
				}

				const createUserResponse = await cognito.send(new AdminCreateUserCommand({
					UserPoolId: process.env.USER_POOL_ID,
					Username: normalizedEmail,
					UserAttributes: [{ Name: "name", Value: name }],
					DesiredDeliveryMediums: [ "EMAIL"],
				}));
		      
				const newCognitoUser = createUserResponse.User;
				if (!newCognitoUser) throw new Error(`Failed to create Cognito user for ${normalizedEmail}`);


				const cognitoSub = newCognitoUser.Attributes?.find(attr => attr.Name === "sub")?.Value;
				if (!cognitoSub) throw new Error("New Cognito user sub not found.");


				const newUserDoc: User = {
					email: normalizedEmail,
					name: name,
					cognitoSub: cognitoSub,
					workspaceId: workspaceObjectId,
					userType: access.userType,
					isManager: access.isManager,
					status: "invited",
				};
				const userResult = await db.collection("users").insertOne(newUserDoc);
				const dbUserId = userResult.insertedId.toString();

				await db.collection<Workspace>("workspaces").updateOne(
					{ _id: workspaceObjectId },
					{ $push: { userIds: new ObjectId(dbUserId) } }
				);
		      
				await cognito.send(new AdminUpdateUserAttributesCommand({
					UserPoolId: process.env.USER_POOL_ID,
					Username: normalizedEmail,
					UserAttributes: [
						{ Name: "custom:userId", Value: dbUserId },
						{ Name: "custom:workspaceId", Value: workspaceObjectId.toString() },
						{ Name: "custom:status", Value: "invited" }
					],
				}));

				await syncMemberCognitoGroups(normalizedEmail, access);

				await recordInvite(dbUserId, 'member.invited', name, normalizedEmail);
				results.push({ email: normalizedEmail, status: "Success" });
			} catch (error: unknown) {
				if (error instanceof InviteEmailConflictError) {
					results.push({ email: normalizedEmail, status: "Failed", reason: error.message });
					continue;
				}

				const message = error instanceof Error ? error.message : 'Invitation failed';
				logError('Failed to invite user', error);
				results.push({ email: normalizedEmail, status: "Failed", reason: message });
			}
		}

		return ResponseWrapper.success({ message: 'Users invited successfully', data:results });
	} catch (error) {
		logError('Invite new user by admin handler failed', error);
		return ResponseWrapper.internalServerError('Failed to invite users');
	}
});
