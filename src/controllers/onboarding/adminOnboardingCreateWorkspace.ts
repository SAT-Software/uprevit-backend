import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getDb } from "../../utils/db";
import type { Workspace } from "../../models/workspace";
import { AuditLogAction } from "../../models/auditLog";
import { updateAuditLog } from "../../utils/auditLog";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { validateMissingFields } from "../../utils/validationUtils";
import { authenticateRequest } from "../../utils/authUtils";
import { User } from "../../models/user";
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient();

/**
 * @param {APIGatewayProxyEvent} event 
 * @return  {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Ensure caller is admin
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const cognitoSub = auth.payload.sub

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		
		const input = JSON.parse(event.body);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');
		

		const validationResult = validateMissingFields({
			workspaceName: input.workspaceName,
			companyName: input.companyName,
			companyId: input.companyId,
			name: input.name,
			email: input.email,
		});
		if (validationResult) return validationResult;

		const db = await getDb();

		const workspace = await db.collection<Workspace>('workspaces').insertOne({
			workspaceName: input.workspaceName,
			companyName: input.companyName,
			companyId: input.companyId,
			description: input.description || '',
			logo: input.logo || '',
			plan: input.plan || '',
			planName: input.planName || '',
			planId: input.planId || '',
			planStart: input.planStart ? new Date(input.planStart) : null,
			planEnd: input.planEnd ? new Date(input.planEnd) : null,
			cost: input.cost || 0,
			userIds: [],
		});

		const workspaceId = workspace.insertedId

		await updateAuditLog({
			entity: 'workspace',
			entityId: workspaceId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString() || auth.payload.sub || 'system',
			actionAt: new Date(),
			active: true,
		});

		const user = await db.collection<User>('users').insertOne({
			name: input.name,
			email: input.email,
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
			Username: cognitoSub, // or the Cognito username if different
			UserAttributes: [
				{ Name: "custom:dbUserId", Value: userId.toString() },
				{ Name: "custom:workspace", Value: workspaceId.toString() },
			],
		}));
		

		return ResponseWrapper.created({
			message: 'Onboarding successful, workspace created',
			workspaceId: workspaceId.toString(),
		});
	} catch (err) {
		console.error('Error in onboarding lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
}