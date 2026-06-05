import {
	AdminGetUserCommand,
	AdminCreateUserCommand,
	AdminUpdateUserAttributesCommand,
	AdminAddUserToGroupCommand,
	CognitoIdentityProviderClient,
	UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { Db, ObjectId } from 'mongodb';
import { User } from '../models/user';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });

export const normalizeInviteEmail = (email: string): string => email.trim().toLowerCase();

export class InviteEmailConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InviteEmailConflictError';
	}
}

/**
 * Returns true when a Cognito user already exists for the email.
 */
export const cognitoUserExists = async (email: string): Promise<boolean> => {
	try {
		await cognito.send(new AdminGetUserCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: email,
		}));
		return true;
	} catch (error) {
		if (error instanceof UserNotFoundException) return false;
		throw error;
	}
};

/**
 * Rejects emails already tied to any workspace or a pending provision (Cognito-only admin).
 */
export const assertEmailAvailableForProvisionInvite = async (
	db: Db,
	email: string,
): Promise<void> => {
	const existingUser = await db.collection<User>('users').findOne({ email });
	if (existingUser) {
		throw new InviteEmailConflictError(
			'This email is already associated with a workspace.',
		);
	}

	if (await cognitoUserExists(email)) {
		throw new InviteEmailConflictError(
			'This email already has a pending organization admin invite or Cognito account.',
		);
	}
};

/**
 * Rejects emails tied to a different workspace.
 */
export const assertEmailAvailableForWorkspaceAdminInvite = async (
	db: Db,
	email: string,
	workspaceId: ObjectId,
): Promise<void> => {
	const existingUser = await db.collection<User>('users').findOne({ email });
	if (!existingUser) return;

	if (!existingUser.workspaceId) {
		throw new InviteEmailConflictError(
			'This email is reserved for organization provisioning and cannot be invited to a workspace yet.',
		);
	}

	if (!existingUser.workspaceId.equals(workspaceId)) {
		throw new InviteEmailConflictError(
			'This email belongs to a different workspace and cannot be invited here.',
		);
	}

	if (existingUser.userType === 'admin') {
		throw new InviteEmailConflictError('This email is already a workspace admin in this workspace.');
	}

	throw new InviteEmailConflictError('This email is already a member of this workspace.');
};

export type CreateInvitedCognitoUserInput = {
	email: string;
	name: string;
	groupName: 'admin' | 'user';
	customAttributes?: Array<{ Name: string; Value: string }>;
};

/**
 * Creates a Cognito user, sets attributes, and adds them to a group.
 */
export const createInvitedCognitoUser = async (
	input: CreateInvitedCognitoUserInput,
): Promise<{ cognitoSub: string }> => {
	const createUserResponse = await cognito.send(new AdminCreateUserCommand({
		UserPoolId: process.env.USER_POOL_ID!,
		Username: input.email,
		UserAttributes: [{ Name: 'name', Value: input.name }],
		DesiredDeliveryMediums: ['EMAIL'],
	}));

	const newCognitoUser = createUserResponse.User;
	if (!newCognitoUser) throw new Error(`Failed to create Cognito user for ${input.email}`);

	const cognitoSub = newCognitoUser.Attributes?.find((attr) => attr.Name === 'sub')?.Value;
	if (!cognitoSub) throw new Error('New Cognito user sub not found.');

	if (input.customAttributes?.length) {
		await cognito.send(new AdminUpdateUserAttributesCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: input.email,
			UserAttributes: input.customAttributes,
		}));
	}

	await cognito.send(new AdminAddUserToGroupCommand({
		UserPoolId: process.env.USER_POOL_ID!,
		Username: input.email,
		GroupName: input.groupName,
	}));

	return { cognitoSub };
};
