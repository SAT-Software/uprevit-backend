import { ObjectId } from 'mongodb';
import type { User } from '../models/user';
import { getDb } from './db';

export type AuthenticatedUserContext = {
	userId: ObjectId;
	workspaceId: ObjectId;
	userType: User['userType'];
	isManager: boolean;
};

/**
 * Resolves authenticated user context from Cognito sub.
 * @param {string} cognitoSub - Cognito `sub` claim
 * @return {Promise<AuthenticatedUserContext | null>} User context or null when unresolved
 */
export const getAuthenticatedUserContext = async (
	cognitoSub: string,
): Promise<AuthenticatedUserContext | null> => {
	if (!cognitoSub) return null;

	const db = await getDb();
	const user = await db.collection<User>('users').findOne(
		{ cognitoSub },
		{ projection: { _id: 1, workspaceId: 1, status: 1, userType: 1, isManager: 1 } },
	);

	if (!user?._id || !(user.workspaceId instanceof ObjectId)) {
		return null;
	}

	if (user.status === 'inactive') {
		return null;
	}

	return {
		userId: user._id,
		workspaceId: user.workspaceId,
		userType: user.userType,
		isManager: user.isManager === true,
	};
};
