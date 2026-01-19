import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminUpdateUserAttributesCommand, AdminAddUserToGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getDb } from "../../utils/db";
import { User } from "../../models/user";
import { ObjectId } from "mongodb";
import { authenticateRequest } from "../../utils/authUtils";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { validateUserArray } from "../../utils/validationUtils";
import { Workspace } from "../../models/workspace";

const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1' });

/**
 * @param {APIGatewayProxyEvent} event 
 * @return  {Promise<APIGatewayProxyResult>}
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;


		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId) return ResponseWrapper.badRequest("Workspace ID is required in path parameters");


		if (!event.body) return ResponseWrapper.badRequest("Request body is required.");

		const users = JSON.parse(event.body);
		const validationError = validateUserArray(users, "users");
		if(validationError) return validationError;

		const db = await getDb();
		const results = [];

		for (const user of users) {
			const { email, name } = user;
			try {
				const createUserResponse = await cognito.send(new AdminCreateUserCommand({
					UserPoolId: process.env.USER_POOL_ID,
					Username: email,
					UserAttributes: [{ Name: "name", Value: name }],
					DesiredDeliveryMediums: [ "EMAIL"],
				}));
		      
				const newCognitoUser = createUserResponse.User;
				if (!newCognitoUser) throw new Error(`Failed to create Cognito user for ${email}`);


				const cognitoSub = newCognitoUser.Attributes?.find(attr => attr.Name === "sub")?.Value;
				if (!cognitoSub) throw new Error("New Cognito user sub not found.");


				const newUserDoc: User = {
					email: email,
					name: name,
					cognitoSub: cognitoSub,
					workspaceId: new ObjectId(workspaceId),
					userType: "user",
					status: "invited",
				};
				const userResult = await db.collection("users").insertOne(newUserDoc);
				const dbUserId = userResult.insertedId.toString();

				await db.collection<Workspace>("workspaces").updateOne(
					{ _id: new ObjectId(workspaceId) },
					{ $push: { userIds: new ObjectId(dbUserId) } }
				);
		      
				await cognito.send(new AdminUpdateUserAttributesCommand({
					UserPoolId: process.env.USER_POOL_ID,
					Username: email,
					UserAttributes: [
						{ Name: "custom:userId", Value: dbUserId },
						{ Name: "custom:workspaceId", Value: workspaceId },
						{ Name: "custom:status", Value: "invited" }
					],
				}));

				await cognito.send(new AdminAddUserToGroupCommand({
					UserPoolId: process.env.USER_POOL_ID!,
					Username: email,
					GroupName: "user",
				}));

				results.push({ email, status: "Success" });
			} catch (error: any) {
				logError(`Failed to invite user: ${email}`, error);
				results.push({ email, status: "Failed", reason: error.message || 'Invitation failed' });
			}
		}

		return ResponseWrapper.success({ message: 'Users invited successfully', data:results });
	} catch (error) {
		logError('Invite new user by admin handler failed', error);
		return ResponseWrapper.internalServerError('Failed to invite users');
	}
};