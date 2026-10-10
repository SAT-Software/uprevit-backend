import {
	AdminAddUserToGroupCommand,
	AdminDisableUserCommand,
	AdminEnableUserCommand,
	AdminRemoveUserFromGroupCommand,
	AdminUpdateUserAttributesCommand,
	CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import { Db, ObjectId } from 'mongodb';
import type { Department } from '../models/department';
import type { Product } from '../models/product';
import type { Project } from '../models/project';
import type { User } from '../models/user';
import type { Workspace } from '../models/workspace';
import { getDb, withTransaction } from './db';
import {
	cognitoUserExists,
	createInvitedCognitoUser,
	deleteCognitoInviteUser,
	normalizeInviteEmail,
} from './platformInviteUtils';
import { assertSeatActivationAllowed, verifySeatLimitAfterActivation } from './billing/enforcement';
import { recordAuditEvent } from './auditLogV2';
import { notify } from './notifications';
import { flagUnavailableAssignments, touchActiveWorkflows } from './workflowAssignments';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });

export class UserRemovalError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'already_inactive' | 'last_admin' | 'invalid_status',
	) {
		super(message);
		this.name = 'UserRemovalError';
	}
}

export class UserReactivationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UserReactivationError';
	}
};

const disableCognitoUser = async (email: string): Promise<void> => {
	await cognito.send(new AdminDisableUserCommand({
		UserPoolId: process.env.USER_POOL_ID!,
		Username: email,
	}));
};

const enableCognitoUser = async (email: string): Promise<void> => {
	await cognito.send(new AdminEnableUserCommand({
		UserPoolId: process.env.USER_POOL_ID!,
		Username: email,
	}));
};

const removeCognitoGroup = async (email: string, groupName: 'admin' | 'user'): Promise<void> => {
	try {
		await cognito.send(new AdminRemoveUserFromGroupCommand({
			UserPoolId: process.env.USER_POOL_ID!,
			Username: email,
			GroupName: groupName,
		}));
	} catch {
		// Group membership may already be absent.
	}
};

const setCognitoStatus = async (email: string, status: string): Promise<void> => {
	await cognito.send(new AdminUpdateUserAttributesCommand({
		UserPoolId: process.env.USER_POOL_ID!,
		Username: email,
		UserAttributes: [{ Name: 'custom:status', Value: status }],
	}));
};

const cleanupMembershipReferences = async (
	db: Db,
	workspaceId: ObjectId,
	targetUserId: ObjectId,
	reassignAdminToUserId: ObjectId,
): Promise<void> => {
	await db.collection<Workspace>('workspaces').updateOne(
		{ _id: workspaceId },
		{ $pull: { userIds: targetUserId } },
	);

	await db.collection<Department>('departments').updateMany(
		{ workspace_id: workspaceId },
		{ $pull: { users: targetUserId } },
	);

	await db.collection<Department>('departments').updateMany(
		{ workspace_id: workspaceId, admin_id: targetUserId },
		{ $set: { admin_id: reassignAdminToUserId } },
	);

	await db.collection<Project>('projects').updateMany(
		{ workspace_id: workspaceId },
		{ $pull: { users: targetUserId } },
	);

	await db.collection<Project>('projects').updateMany(
		{ workspace_id: workspaceId, admin_id: targetUserId },
		{ $set: { admin_id: reassignAdminToUserId } },
	);

	await db.collection('bookmarks').deleteMany({
		user_id: targetUserId,
		workspace_id: workspaceId,
	});
};

const reassignProductTeams = async (
	db: Db,
	workspaceId: ObjectId,
	targetUserId: ObjectId,
	targetName: string,
	actorUserId: ObjectId,
	auth: Partial<CognitoAccessTokenPayload>,
): Promise<void> => {
	const ownedProducts = await db.collection<Product>('products')
		.find({ workspace_id: workspaceId, owner_user_id: targetUserId, is_latest: true }, { projection: { product_name: 1 } })
		.toArray();

	const reassigned = await withTransaction(async (txDb, session) => {
		const products = txDb.collection<Product>('products');
		await products.updateMany(
			{ workspace_id: workspaceId, contributor_user_ids: targetUserId },
			{ $pull: { contributor_user_ids: targetUserId } },
			{ session },
		);
		const result = await products.updateMany(
			{ workspace_id: workspaceId, owner_user_id: targetUserId },
			{ $set: { owner_user_id: actorUserId }, $pull: { contributor_user_ids: actorUserId } },
			{ session },
		);
		await touchActiveWorkflows(txDb, workspaceId, { 'assignments.userId': targetUserId }, session);
		return result;
	});
	if (reassigned.modifiedCount === 0 || ownedProducts.length === 0) return;

	const actor = await db.collection<User>('users').findOne({ _id: actorUserId }, { projection: { name: 1 } });
	await Promise.all(ownedProducts.map((product) => recordAuditEvent({
		workspaceId: workspaceId.toString(),
		scope: { type: 'product', id: product._id.toString() },
		entity: { type: 'product', id: product._id.toString() },
		action: 'update',
		eventKey: 'product.owner.changed',
		visibility: 'all',
		where: { module: 'products' },
		auth,
		changes: [{ path: 'owner_user_id', from: targetUserId.toString(), to: actorUserId.toString() }],
		meta: { productName: product.product_name, memberName: actor?.name, reason: 'member_removed' },
	})));

	const [first] = ownedProducts;
	await notify({
		workspaceId,
		recipients: [actorUserId],
		type: 'product.ownership_transferred',
		title: ownedProducts.length === 1
			? `You are now the Product Owner of ${first.product_name}`
			: `You are now the Product Owner of ${ownedProducts.length} products`,
		body: `${targetName} was removed from the workspace, so their products moved to you.`,
		link: ownedProducts.length === 1 ? `/products/${first._id.toString()}/product-information` : '/products',
		meta: { productIds: ownedProducts.map((product) => product._id.toString()), removedUserId: targetUserId.toString() },
	});
};

export const countActiveWorkspaceAdmins = async (
	db: Db,
	workspaceId: ObjectId,
): Promise<number> =>
	db.collection<User>('users').countDocuments({
		workspaceId,
		userType: 'admin',
		status: 'active',
	});

export const deactivateWorkspaceUser = async ({
	targetUserId,
	workspaceId,
	actorUserId,
	auth,
}: {
	targetUserId: ObjectId;
	workspaceId: ObjectId;
	actorUserId: ObjectId;
	auth: Partial<CognitoAccessTokenPayload>;
}): Promise<User> => {
	const db = await getDb();

	const targetUser = await db.collection<User>('users').findOne({
		_id: targetUserId,
		workspaceId,
	});

	if (!targetUser) {
		throw new UserRemovalError('User not found', 'not_found');
	}

	if (targetUser.status === 'inactive') {
		throw new UserRemovalError('User is already removed from this workspace', 'already_inactive');
	}

	if (targetUser.status !== 'active' && targetUser.status !== 'invited') {
		throw new UserRemovalError('User cannot be removed in their current state', 'invalid_status');
	}

	if (targetUser.userType === 'admin' && targetUser.status === 'active') {
		const activeAdminCount = await countActiveWorkspaceAdmins(db, workspaceId);
		if (activeAdminCount <= 1) {
			throw new UserRemovalError(
				'Cannot remove the last active workspace admin. Promote another admin first.',
				'last_admin',
			);
		}
	}

	const now = new Date();

	if (targetUser.status === 'invited') {
		await deleteCognitoInviteUser(targetUser.email);
	} else {
		await disableCognitoUser(targetUser.email);
		await setCognitoStatus(targetUser.email, 'inactive');
		const groupName = targetUser.userType === 'admin' ? 'admin' : 'user';
		await removeCognitoGroup(targetUser.email, groupName);
	}

	await cleanupMembershipReferences(db, workspaceId, targetUserId, actorUserId);
	await reassignProductTeams(db, workspaceId, targetUserId, targetUser.name || 'A member', actorUserId, auth);

	await withTransaction(async (txDb, session) => {
		await txDb.collection<User>('users').updateOne(
			{ _id: targetUserId, workspaceId },
			{
				$set: {
					status: 'inactive',
					removedAt: now,
					removedByUserId: actorUserId,
				},
			},
			{ session },
		);
		await touchActiveWorkflows(txDb, workspaceId, { 'assignments.userId': targetUserId }, session);
	});
	await flagUnavailableAssignments({ db, workspaceId, actorId: actorUserId, userId: targetUserId });

	const updatedUser = await db.collection<User>('users').findOne({ _id: targetUserId });
	if (!updatedUser) {
		throw new UserRemovalError('User not found after deactivation', 'not_found');
	}

	return updatedUser;
};

export type ReactivateWorkspaceUserInput = {
	email: string;
	name: string;
	workspaceId: ObjectId;
	actorUserId: ObjectId;
	userType?: 'user' | 'admin';
};

export type ReactivateWorkspaceUserResult = {
	userId: ObjectId;
	reactivated: true;
};

export const findInactiveWorkspaceUserByEmail = async (
	db: Db,
	email: string,
	workspaceId: ObjectId,
): Promise<User | null> => {
	const normalizedEmail = normalizeInviteEmail(email);
	const candidates = await db.collection<User>('users').find({
		workspaceId,
		status: 'inactive',
	}).toArray();

	return candidates.find((user) => normalizeInviteEmail(user.email) === normalizedEmail) ?? null;
};

export const reactivateWorkspaceUser = async (
	input: ReactivateWorkspaceUserInput,
): Promise<ReactivateWorkspaceUserResult> => {
	const db = await getDb();
	const normalizedEmail = normalizeInviteEmail(input.email);
	const workspaceId = input.workspaceId;

	const existingUser = await findInactiveWorkspaceUserByEmail(db, normalizedEmail, workspaceId);
	if (!existingUser?._id) {
		throw new UserReactivationError('No removed member found with this email in this workspace');
	}

	const userType = input.userType ?? existingUser.userType ?? 'user';
	const groupName = userType === 'admin' ? 'admin' : 'user';
	const userId = existingUser._id;
	const seatCheck = await assertSeatActivationAllowed(workspaceId, 1);
	if (!seatCheck.allowed) {
		throw new UserReactivationError(seatCheck.reason);
	}

	let cognitoSub = existingUser.cognitoSub;
	const hasCognitoAccount = await cognitoUserExists(normalizedEmail);
	let createdNewCognito = false;

	const rollbackCognito = async (): Promise<void> => {
		if (createdNewCognito) {
			await deleteCognitoInviteUser(normalizedEmail);
			return;
		}

		if (hasCognitoAccount) {
			await disableCognitoUser(normalizedEmail);
			await setCognitoStatus(normalizedEmail, 'inactive');
			await removeCognitoGroup(normalizedEmail, groupName);
		}
	};

	const rollbackDbActivation = async (): Promise<void> => {
		await db.collection<User>('users').updateOne(
			{ _id: userId },
			{
				$set: {
					name: existingUser.name,
					email: existingUser.email,
					status: 'inactive',
					userType: existingUser.userType ?? userType,
					removedAt: existingUser.removedAt ?? new Date(),
					removedByUserId: existingUser.removedByUserId ?? input.actorUserId,
					...(existingUser.cognitoSub ? { cognitoSub: existingUser.cognitoSub } : {}),
				},
				...(createdNewCognito && !existingUser.cognitoSub ? { $unset: { cognitoSub: '' } } : {}),
			},
		);
		await db.collection<Workspace>('workspaces').updateOne(
			{ _id: workspaceId },
			{ $pull: { userIds: userId } },
		);
	};

	try {
		if (!cognitoSub || !hasCognitoAccount) {
			const created = await createInvitedCognitoUser({
				email: normalizedEmail,
				name: input.name,
				groupName,
				customAttributes: [
					{ Name: 'custom:userId', Value: userId.toString() },
					{ Name: 'custom:workspaceId', Value: workspaceId.toString() },
					{ Name: 'custom:status', Value: 'active' },
				],
			});
			cognitoSub = created.cognitoSub;
			createdNewCognito = true;
		} else {
			await enableCognitoUser(normalizedEmail);
			await cognito.send(new AdminUpdateUserAttributesCommand({
				UserPoolId: process.env.USER_POOL_ID!,
				Username: normalizedEmail,
				UserAttributes: [
					{ Name: 'name', Value: input.name },
					{ Name: 'custom:userId', Value: userId.toString() },
					{ Name: 'custom:workspaceId', Value: workspaceId.toString() },
					{ Name: 'custom:status', Value: 'active' },
				],
			}));

			await cognito.send(new AdminAddUserToGroupCommand({
				UserPoolId: process.env.USER_POOL_ID!,
				Username: normalizedEmail,
				GroupName: groupName,
			}));
		}

		await db.collection<User>('users').updateOne(
			{ _id: userId },
			{
				$set: {
					name: input.name,
					email: normalizedEmail,
					cognitoSub,
					status: 'active',
					userType,
				},
				$unset: {
					removedAt: '',
					removedByUserId: '',
				},
			},
		);

		await db.collection<Workspace>('workspaces').updateOne(
			{ _id: workspaceId },
			{ $addToSet: { userIds: userId } },
		);

		const postActivationCheck = await verifySeatLimitAfterActivation(workspaceId);
		if (!postActivationCheck.allowed) {
			await rollbackDbActivation();
			await rollbackCognito();
			throw new UserReactivationError(postActivationCheck.reason);
		}

		return { userId, reactivated: true };
	} catch (error) {
		if (!(error instanceof UserReactivationError)) {
			try {
				await rollbackDbActivation();
			} catch {
				// Best-effort DB rollback after a partial activation.
			}
			try {
				await rollbackCognito();
			} catch {
				// Best-effort Cognito rollback after a partial activation.
			}
			throw new UserReactivationError(
				error instanceof Error ? error.message : 'Failed to reactivate workspace user',
			);
		}
		throw error;
	}
};
