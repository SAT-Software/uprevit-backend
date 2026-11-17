import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const cognitoSend = jest.fn<(command: { name: string; input: any }) => Promise<any>>();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
	const command = (name: string) => jest.fn().mockImplementation((input) => ({ name, input }));
	return {
		CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send: cognitoSend })),
		AdminCreateUserCommand: command('AdminCreateUser'),
		AdminDeleteUserCommand: command('AdminDeleteUser'),
		AdminUpdateUserAttributesCommand: command('AdminUpdateUserAttributes'),
		AdminGetUserCommand: command('AdminGetUser'),
		AdminAddUserToGroupCommand: command('AdminAddUserToGroup'),
		UserNotFoundException: class UserNotFoundException extends Error {},
	};
});

jest.mock('../../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../../utils/tenantContext', () => ({
	...(jest.requireActual('../../utils/tenantContext') as object),
	requireTenantContext: jest.fn(),
}));
jest.mock('../../utils/auditLogV2', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../../utils/billing/uploadCommit', () => ({ recordCommittedUploadIfNew: jest.fn() }));
jest.mock('../../utils/billing/enforcement', () => ({
	assertUsageActionAllowed: jest.fn(async () => ({ allowed: true })),
	releaseDailyInvites: jest.fn(async () => undefined),
}));
jest.mock('../../utils/userRemoval', () => ({
	findInactiveWorkspaceUserByEmail: jest.fn(async () => null),
	reactivateWorkspaceUser: jest.fn(),
}));
jest.mock('../../utils/memberAccess', () => ({
	...(jest.requireActual('../../utils/memberAccess') as object),
	syncMemberCognitoGroups: jest.fn(),
}));

const { getDb } = jest.requireMock('../../utils/db') as any;
const { requireTenantContext } = jest.requireMock('../../utils/tenantContext') as any;
const { assertUsageActionAllowed, releaseDailyInvites } = jest.requireMock('../../utils/billing/enforcement') as any;
const { lambdaHandler: createUser } = require('../../controllers/users/createUser');
const { handler: inviteUsers } = require('../../controllers/onboarding/InviteNewUserByAdmin');
const { validateUserArray } = require('../../utils/validationUtils');

const workspaceId = new ObjectId();

const buildEvent = (body: unknown, pathParameters: Record<string, string> | null = null): APIGatewayProxyEvent => ({
	headers: { Authorization: 'Bearer token' },
	body: JSON.stringify(body),
	pathParameters,
	requestContext: { requestId: 'req-1' },
} as unknown as APIGatewayProxyEvent);

const mockUsers = (existing: Record<string, unknown> | null) => {
	const users = {
		findOne: jest.fn(async () => existing),
		insertOne: jest.fn(async () => ({ insertedId: new ObjectId() })),
		deleteOne: jest.fn(),
	};
	getDb.mockResolvedValue({
		collection: jest.fn((name: string) => (name === 'users' ? users : { updateOne: jest.fn() })),
	});
	return users;
};

describe('member creation and invites', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId, userId: new ObjectId(), cognitoGroups: ['admin'] },
			auth: { payload: { sub: 'admin-sub' } },
		});
	});

	it('createUser rejects an email owned by another workspace', async () => {
		const users = mockUsers({ email: 'taken@example.com', workspaceId: new ObjectId(), status: 'active' });

		const response = await createUser(buildEvent({ name: 'Squatter', email: ' Taken@Example.com ', userType: 'user' }));

		expect(response.statusCode).toBe(409);
		expect(users.insertOne).not.toHaveBeenCalled();
	});

	it('createUser stores the normalized email', async () => {
		const users = mockUsers(null);
		cognitoSend.mockRejectedValue(new (jest.requireMock('@aws-sdk/client-cognito-identity-provider') as any).UserNotFoundException());

		const response = await createUser(buildEvent({ name: 'New', email: ' New@Example.com ', userType: 'user' }));

		expect(response.statusCode).toBe(201);
		expect(users.insertOne).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com' }));
	});

	it.each([
		['empty', []],
		['over the cap', Array.from({ length: 11 }, (_, index) => ({ name: 'n', email: `u${index}@example.com` }))],
		['an invalid email', [{ name: 'n', email: 'not-an-email' }]],
	])('rejects an invite batch that is %s', (_label, batch) => {
		expect(validateUserArray(batch, 'users')?.statusCode).toBe(400);
	});

	it('meters the whole invite batch against the daily cap', async () => {
		mockUsers(null);
		assertUsageActionAllowed.mockResolvedValueOnce({ allowed: false, reason: 'Daily invite limit reached for this workspace' });

		const response = await inviteUsers(buildEvent(
			[{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'b@example.com' }],
			{ workspaceId: workspaceId.toString() },
		));

		expect(response.statusCode).toBe(403);
		expect(assertUsageActionAllowed).toHaveBeenCalledWith(workspaceId, 'invite', 2, expect.any(Date));
		expect(cognitoSend).not.toHaveBeenCalled();
	});

	it('resumes an invite whose Cognito user was created by this workspace', async () => {
		const users = mockUsers(null);
		cognitoSend.mockImplementation(async (command) => (command.name === 'AdminGetUser'
			? { UserAttributes: [{ Name: 'sub', Value: 'orphan-sub' }, { Name: 'custom:workspaceId', Value: workspaceId.toString() }] }
			: {}));

		const response = await inviteUsers(buildEvent([{ name: 'A', email: 'a@example.com' }], { workspaceId: workspaceId.toString() }));

		expect(JSON.parse(response.body).data).toEqual([{ email: 'a@example.com', status: 'Success' }]);
		expect(cognitoSend.mock.calls.map(([command]) => command.name)).not.toContain('AdminCreateUser');
		expect(users.insertOne).toHaveBeenCalledWith(expect.objectContaining({ cognitoSub: 'orphan-sub' }));
	});

	it('tags new Cognito invitees with the workspace so a retry can resume', async () => {
		mockUsers(null);
		const { UserNotFoundException } = jest.requireMock('@aws-sdk/client-cognito-identity-provider') as any;
		cognitoSend.mockImplementation(async (command) => {
			if (command.name === 'AdminGetUser') throw new UserNotFoundException();
			if (command.name === 'AdminCreateUser') return { User: { Attributes: [{ Name: 'sub', Value: 'new-sub' }] } };
			return {};
		});

		await inviteUsers(buildEvent([{ name: 'A', email: 'a@example.com' }], { workspaceId: workspaceId.toString() }));

		const create = cognitoSend.mock.calls.find(([command]) => command.name === 'AdminCreateUser')?.[0];
		expect(create?.input.UserAttributes).toContainEqual({ Name: 'custom:workspaceId', Value: workspaceId.toString() });
	});

	it('keeps the Cognito account when a parallel invite already claimed the email', async () => {
		const users = mockUsers(null);
		users.insertOne.mockRejectedValue({ code: 11000 });
		const { UserNotFoundException } = jest.requireMock('@aws-sdk/client-cognito-identity-provider') as any;
		cognitoSend.mockImplementation(async (command) => {
			if (command.name === 'AdminGetUser') throw new UserNotFoundException();
			if (command.name === 'AdminCreateUser') return { User: { Attributes: [{ Name: 'sub', Value: 'new-sub' }] } };
			return {};
		});

		const response = await inviteUsers(buildEvent([{ name: 'A', email: 'a@example.com' }], { workspaceId: workspaceId.toString() }));

		expect(JSON.parse(response.body).data[0]).toMatchObject({ status: 'Failed', reason: 'This email is already being invited.' });
		expect(cognitoSend.mock.calls.map(([command]) => command.name)).not.toContain('AdminDeleteUser');
		expect(releaseDailyInvites).toHaveBeenCalledWith(workspaceId, 1, assertUsageActionAllowed.mock.calls[0][3]);
	});
});
