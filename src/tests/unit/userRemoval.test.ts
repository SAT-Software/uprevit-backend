import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/authUtils', () => ({
	authenticateRequest: jest.fn(),
}));

jest.mock('../../utils/auditLog', () => ({
	updateAuditLog: jest.fn(),
}));

jest.mock('../../utils/billing/enforcement', () => ({
	assertWorkspaceAccessAllowed: jest.fn(async () => ({ allowed: true })),
	assertSeatActivationAllowed: jest.fn(async () => ({ allowed: true })),
	verifySeatLimitAfterActivation: jest.fn(async () => ({ allowed: true })),
}));

const cognitoSend = jest.fn(async () => ({}));

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
	CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
		send: cognitoSend,
	})),
	AdminDisableUserCommand: jest.fn(),
	AdminEnableUserCommand: jest.fn(),
	AdminRemoveUserFromGroupCommand: jest.fn(),
	AdminUpdateUserAttributesCommand: jest.fn(),
	AdminAddUserToGroupCommand: jest.fn(),
	AdminDeleteUserCommand: jest.fn(),
	UserNotFoundException: class UserNotFoundException extends Error {},
}));

jest.mock('../../utils/platformInviteUtils', () => ({
	normalizeInviteEmail: (email: string) => email.trim().toLowerCase(),
	deleteCognitoInviteUser: jest.fn(async () => undefined),
	cognitoUserExists: jest.fn(async () => true),
	createInvitedCognitoUser: jest.fn(async () => ({ cognitoSub: 'new-sub' })),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const authUtils = jest.requireMock('../../utils/authUtils') as any;
const inviteUtils = jest.requireMock('../../utils/platformInviteUtils') as any;
const billingEnforcement = jest.requireMock('../../utils/billing/enforcement') as any;

const {
	deactivateWorkspaceUser,
	countActiveWorkspaceAdmins,
	reactivateWorkspaceUser,
	UserRemovalError,
	UserReactivationError,
} = require('../../utils/userRemoval');
const { getAuthenticatedUserContext } = require('../../utils/authenticatedUser');
const { lambdaHandler: deleteUserHandler } = require('../../controllers/users/deleteUser');

type CollectionMocks = Record<string, {
	findOne: ReturnType<typeof jest.fn>;
	updateOne: ReturnType<typeof jest.fn>;
	updateMany: ReturnType<typeof jest.fn>;
	deleteMany: ReturnType<typeof jest.fn>;
	countDocuments: ReturnType<typeof jest.fn>;
	find: ReturnType<typeof jest.fn>;
}>;

const workspaceId = new ObjectId();
const actorUserId = new ObjectId();
const targetUserId = new ObjectId();

const createDb = () => {
	const collections: CollectionMocks = {};

	const getCollection = (name: string) => {
		if (!collections[name]) {
			collections[name] = {
				findOne: jest.fn(),
				updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
				updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
				deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
				countDocuments: jest.fn(async () => 0),
				find: jest.fn(() => ({
					toArray: jest.fn(async () => []),
				})),
			};
		}
		return collections[name];
	};

	dbModule.getDb.mockResolvedValue({
		collection: getCollection,
	});

	const primeCollections = (...names: string[]) => {
		names.forEach((name) => getCollection(name));
	};

	return { collections, getCollection, primeCollections };
};

const buildDeleteEvent = (targetId: string): APIGatewayProxyEvent => ({
	httpMethod: 'DELETE',
	path: `/users/${targetId}`,
	headers: { Authorization: 'Bearer token' },
	body: null,
	pathParameters: { id: targetId },
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
} as APIGatewayProxyEvent);

describe('userRemoval', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		cognitoSend.mockResolvedValue({});
		inviteUtils.cognitoUserExists.mockResolvedValue(true);
	});

	it('deactivates an active user and cleans up membership references', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users', 'workspaces', 'departments', 'projects', 'bookmarks');
		const activeUser = {
			_id: targetUserId,
			email: 'member@example.com',
			name: 'Member',
			status: 'active',
			userType: 'user',
			cognitoSub: 'sub-1',
			workspaceId,
		};

		collections.users.findOne
			.mockResolvedValueOnce(activeUser)
			.mockResolvedValueOnce({ ...activeUser, status: 'inactive' });

		await deactivateWorkspaceUser({
			targetUserId,
			workspaceId,
			actorUserId,
		});

		expect(collections.workspaces.updateOne).toHaveBeenCalled();
		expect(collections.departments.updateMany).toHaveBeenCalled();
		expect(collections.projects.updateMany).toHaveBeenCalled();
		expect(collections.bookmarks.deleteMany).toHaveBeenCalled();
		expect(collections.users.updateOne).toHaveBeenCalledWith(
			{ _id: targetUserId, workspaceId },
			expect.objectContaining({
				$set: expect.objectContaining({ status: 'inactive' }),
			}),
		);
		expect(inviteUtils.deleteCognitoInviteUser).not.toHaveBeenCalled();
	});

	it('deletes Cognito for invited users being removed', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users', 'workspaces', 'departments', 'projects', 'bookmarks');
		const invitedUser = {
			_id: targetUserId,
			email: 'invited@example.com',
			name: 'Invited',
			status: 'invited',
			userType: 'user',
			cognitoSub: 'sub-2',
			workspaceId,
		};

		collections.users.findOne
			.mockResolvedValueOnce(invitedUser)
			.mockResolvedValueOnce({ ...invitedUser, status: 'inactive' });

		await deactivateWorkspaceUser({
			targetUserId,
			workspaceId,
			actorUserId,
		});

		expect(inviteUtils.deleteCognitoInviteUser).toHaveBeenCalledWith('invited@example.com');
	});

	it('blocks removing the last active workspace admin', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users');
		collections.users.findOne.mockResolvedValue({
			_id: targetUserId,
			email: 'admin@example.com',
			status: 'active',
			userType: 'admin',
			workspaceId,
		});
		collections.users.countDocuments.mockResolvedValue(1);

		await expect(deactivateWorkspaceUser({
			targetUserId,
			workspaceId,
			actorUserId,
		})).rejects.toBeInstanceOf(UserRemovalError);
	});

	it('reactivates an inactive user after checking seat activation limits', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users', 'workspaces');
		const inactiveUser = {
			_id: targetUserId,
			email: 'member@example.com',
			name: 'Member',
			status: 'inactive',
			userType: 'user',
			cognitoSub: 'sub-1',
			workspaceId,
		};

		collections.users.find.mockReturnValue({
			toArray: jest.fn(async () => [inactiveUser]),
		});

		const result = await reactivateWorkspaceUser({
			email: 'member@example.com',
			name: 'Member',
			workspaceId,
			actorUserId,
		});

		expect(result.reactivated).toBe(true);
		expect(billingEnforcement.assertSeatActivationAllowed).toHaveBeenCalledWith(workspaceId, 1);
		expect(billingEnforcement.verifySeatLimitAfterActivation).toHaveBeenCalledWith(workspaceId);
		expect(collections.workspaces.updateOne).toHaveBeenCalled();
	});

	it('rolls back Cognito when database activation fails after enabling an existing user', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users', 'workspaces');
		const inactiveUser = {
			_id: targetUserId,
			email: 'member@example.com',
			name: 'Member',
			status: 'inactive',
			userType: 'user',
			cognitoSub: 'sub-1',
			workspaceId,
		};

		collections.users.find.mockReturnValue({
			toArray: jest.fn(async () => [inactiveUser]),
		});
		collections.users.updateOne.mockRejectedValueOnce(new Error('Database write failed'));

		await expect(reactivateWorkspaceUser({
			email: 'member@example.com',
			name: 'Member',
			workspaceId,
			actorUserId,
		})).rejects.toBeInstanceOf(UserReactivationError);

		expect(cognitoSend).toHaveBeenCalled();
		expect(collections.users.updateOne).toHaveBeenCalled();
	});

	it('rejects reactivation when post-activation seat verification fails', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users', 'workspaces');
		const inactiveUser = {
			_id: targetUserId,
			email: 'member@example.com',
			name: 'Member',
			status: 'inactive',
			userType: 'user',
			cognitoSub: 'sub-1',
			workspaceId,
		};

		collections.users.find.mockReturnValue({
			toArray: jest.fn(async () => [inactiveUser]),
		});
		billingEnforcement.verifySeatLimitAfterActivation.mockResolvedValueOnce({
			allowed: false,
			reason: 'Seat limit reached for this workspace',
		});

		await expect(reactivateWorkspaceUser({
			email: 'member@example.com',
			name: 'Member',
			workspaceId,
			actorUserId,
		})).rejects.toBeInstanceOf(UserReactivationError);

		expect(collections.users.updateOne).toHaveBeenCalledTimes(2);
		expect(collections.workspaces.updateOne).toHaveBeenCalledTimes(2);
	});

	it('rejects inactive users in authenticated user context', async () => {
		const { collections, primeCollections } = createDb();
		primeCollections('users');
		collections.users.findOne.mockResolvedValue({
			_id: targetUserId,
			workspaceId,
			status: 'inactive',
		});

		const context = await getAuthenticatedUserContext('sub-inactive');
		expect(context).toBeNull();
	});
});

describe('deleteUser handler', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authUtils.authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: { sub: 'admin-sub', 'cognito:groups': ['admin'] },
		});
	});

	it('blocks self-removal', async () => {
		const selfId = actorUserId.toString();
		const { collections, primeCollections } = createDb();
		primeCollections('users');
		collections.users.findOne.mockResolvedValue({
			_id: actorUserId,
			workspaceId,
			status: 'active',
			cognitoSub: 'admin-sub',
		});

		const response = await deleteUserHandler(buildDeleteEvent(selfId));
		expect(response.statusCode).toBe(400);
	});

	it('returns forbidden for non-admin callers', async () => {
		authUtils.authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: { sub: 'user-sub', 'cognito:groups': ['user'] },
		});
		const { collections, primeCollections } = createDb();
		primeCollections('users');
		collections.users.findOne.mockResolvedValue({
			_id: actorUserId,
			workspaceId,
			status: 'active',
			cognitoSub: 'user-sub',
		});

		const response = await deleteUserHandler(buildDeleteEvent(targetUserId.toString()));
		expect(response.statusCode).toBe(403);
	});
});
