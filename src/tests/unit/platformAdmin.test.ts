import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/authUtils', () => ({
	authenticateRequest: jest.fn(),
}));

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/platformAuditLog', () => ({
	ensurePlatformAdminIndexes: jest.fn(),
	ensurePlatformAuditLogIndexes: jest.fn(),
	recordPlatformAuditEvent: jest.fn(),
	parseCognitoGroups: (groups: unknown) => {
		if (Array.isArray(groups)) return groups;
		return [];
	},
}));

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
	CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
		send: jest.fn(async () => ({})),
	})),
	AdminUpdateUserAttributesCommand: jest.fn(),
	AdminCreateUserCommand: jest.fn(),
	AdminAddUserToGroupCommand: jest.fn(),
	AdminGetUserCommand: jest.fn(),
	UserNotFoundException: class UserNotFoundException extends Error {},
}));

jest.mock('../../utils/platformInviteUtils', () => ({
	normalizeInviteEmail: (email: string) => email.trim().toLowerCase(),
	assertEmailAvailableForProvisionInvite: jest.fn(),
	assertEmailAvailableForWorkspaceAdminInvite: jest.fn(),
	createInvitedCognitoUser: jest.fn(),
	InviteEmailConflictError: class InviteEmailConflictError extends Error {},
	cognitoUserExists: jest.fn(),
}));

const authUtils = jest.requireMock('../../utils/authUtils') as any;
const dbModule = jest.requireMock('../../utils/db') as any;
const auditLog = jest.requireMock('../../utils/platformAuditLog') as any;
const inviteUtils = jest.requireMock('../../utils/platformInviteUtils') as any;

const { requirePlatformOperator } = require('../../utils/platformAdminContext');
const { lambdaHandler: getSessionHandler } = require('../../controllers/platformAdmin/getSession');
const { lambdaHandler: provisionInviteHandler } = require('../../controllers/platformAdmin/provisionInvite');
const { lambdaHandler: inviteWorkspaceAdminHandler } = require('../../controllers/platformAdmin/inviteWorkspaceAdmin');
const { lambdaHandler: listAuditLogsHandler } = require('../../controllers/platformAdmin/listAuditLogs');
const { lambdaHandler: updateBillingAccountHandler } = require('../../controllers/platformAdmin/updateBillingAccount');
const { lambdaHandler: createUsageAdjustmentHandler } = require('../../controllers/platformAdmin/createUsageAdjustment');
const { serializeWorkspaceListItem, serializePlatformAuditLog } = require('../../utils/platformAdminSerializers');

const activeOperator = {
	_id: new ObjectId(),
	cognitoSub: 'platform-sub',
	email: 'operator@uprevit.com',
	name: 'Operator',
	status: 'active',
	role: 'owner',
	createdAt: new Date(),
	updatedAt: new Date(),
};

const activeWorkspaceUser = {
	_id: new ObjectId(),
	cognitoSub: 'platform-sub',
	email: 'operator@uprevit.com',
	name: 'Operator',
	status: 'active',
	workspaceId: new ObjectId(),
};

const buildEvent = (overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
	httpMethod: 'GET',
	path: '/platform-admin/session',
	headers: { Authorization: 'Bearer token' },
	body: null,
	pathParameters: null,
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
	...overrides,
} as APIGatewayProxyEvent);

const mockValidOperatorAuth = () => {
	authUtils.authenticateRequest.mockResolvedValue({
		isValid: true,
		payload: { sub: 'platform-sub', 'cognito:groups': ['platform-admin'] },
		token: 'token',
	});
};

type CollectionMocks = Record<string, {
	findOne: ReturnType<typeof jest.fn>;
	updateOne: ReturnType<typeof jest.fn>;
	insertOne: ReturnType<typeof jest.fn>;
	find: ReturnType<typeof jest.fn>;
	aggregate: ReturnType<typeof jest.fn>;
	countDocuments: ReturnType<typeof jest.fn>;
	createIndex: ReturnType<typeof jest.fn>;
	findOneAndUpdate: ReturnType<typeof jest.fn>;
}>;

const createDb = () => {
	const collections: CollectionMocks = {};

	const getCollection = (name: string) => {
		if (!collections[name]) {
			collections[name] = {
				findOne: jest.fn(),
				updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 } as never),
				insertOne: jest.fn(),
				find: jest.fn(),
				aggregate: jest.fn(),
				countDocuments: jest.fn(),
				createIndex: jest.fn().mockResolvedValue(undefined as never),
				findOneAndUpdate: jest.fn(),
			};
		}
		return collections[name];
	};

	dbModule.getDb.mockResolvedValue({
		collection: jest.fn((name: string) => getCollection(name)),
	});

	return { collections, getCollection };
};

const setupDualHatOperator = (getCollection: (name: string) => CollectionMocks[string]) => {
	getCollection('platformAdmins').findOne.mockResolvedValue(activeOperator);
	getCollection('users').findOne.mockResolvedValue(activeWorkspaceUser);
};

describe('platformAdmin', () => {
	let collections: CollectionMocks;
	let getCollection: (name: string) => CollectionMocks[string];

	beforeEach(() => {
		jest.clearAllMocks();
		({ collections, getCollection } = createDb());
		setupDualHatOperator(getCollection);
	});

	describe('requirePlatformOperator', () => {
		it('returns forbidden when Cognito lacks platform-admin group', async () => {
			authUtils.authenticateRequest.mockResolvedValue({
				isValid: true,
				payload: { sub: 'sub', 'cognito:groups': ['admin'] },
				token: 'token',
			});

			const result = await requirePlatformOperator(buildEvent());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.response.statusCode).toBe(403);
			}
		});

		it('returns forbidden and logs allowlist failure without registry row', async () => {
			mockValidOperatorAuth();
			getCollection('platformAdmins').findOne.mockResolvedValue(null);

			const result = await requirePlatformOperator(buildEvent());

			expect(result.ok).toBe(false);
			expect(auditLog.recordPlatformAuditEvent).toHaveBeenCalledWith(
				expect.objectContaining({ action: 'platform_operator.allowlist_failed' }),
			);
		});

		it('returns forbidden when registry row is disabled', async () => {
			mockValidOperatorAuth();
			getCollection('platformAdmins').findOne.mockResolvedValue({ ...activeOperator, status: 'disabled' });

			const result = await requirePlatformOperator(buildEvent());

			expect(result.ok).toBe(false);
		});

		it('returns forbidden when operator has no active workspace membership', async () => {
			mockValidOperatorAuth();
			getCollection('users').findOne.mockResolvedValue(null);

			const result = await requirePlatformOperator(buildEvent());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.response.statusCode).toBe(403);
			}
			expect(auditLog.recordPlatformAuditEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'platform_operator.allowlist_failed',
					summary: expect.stringContaining('dual-hat'),
				}),
			);
		});

		it('passes when Cognito group, registry row, and active workspace user exist', async () => {
			mockValidOperatorAuth();

			const result = await requirePlatformOperator(buildEvent());

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.context.operator.email).toBe('operator@uprevit.com');
			}
		});
	});

	describe('serializers', () => {
		it('serializeWorkspaceListItem prefers aggregated memberCount over userIds', () => {
			const workspaceId = new ObjectId();
			const serialized = serializeWorkspaceListItem({
				_id: workspaceId,
				workspaceName: 'Acme',
				companyName: 'Acme Co',
				userIds: [new ObjectId()],
				memberCount: 6,
			});

			expect(serialized.memberCount).toBe(6);
		});

		it('serializePlatformAuditLog returns occurredAt as ISO string', () => {
			const occurredAt = new Date('2024-06-01T12:00:00.000Z');
			const serialized = serializePlatformAuditLog({
				_id: new ObjectId(),
				schemaVersion: 1,
				actor: { cognitoSub: 'sub', groups: ['platform-admin'] },
				action: 'workspace.detail.view',
				target: { type: 'workspace' },
				summary: 'Viewed workspace',
				status: 'success',
				occurredAt,
			});

			expect(serialized.occurredAt).toBe(occurredAt.toISOString());
		});
	});

	describe('getSession', () => {
		it('returns operator profile without session access audit log', async () => {
			mockValidOperatorAuth();

			const response = await getSessionHandler(buildEvent());
			const body = JSON.parse(response.body);

			expect(response.statusCode).toBe(200);
			expect(body.data.email).toBe('operator@uprevit.com');
			expect(auditLog.recordPlatformAuditEvent).not.toHaveBeenCalledWith(
				expect.objectContaining({ action: 'platform_operator.session_access' }),
			);
		});
	});

	describe('listAuditLogs', () => {
		it('excludes session access events by default', async () => {
			mockValidOperatorAuth();

			const auditItems = [{ _id: new ObjectId(), occurredAt: new Date(), action: 'workspace.detail.view', summary: 'x', status: 'success', actor: { cognitoSub: 'sub', groups: [] }, target: { type: 'workspace' } }];
			const toArray = jest.fn().mockResolvedValue(auditItems as never);
			const limit = jest.fn(() => ({ toArray }));
			const skip = jest.fn(() => ({ limit }));
			const sort = jest.fn(() => ({ skip }));
			getCollection('platformAuditLogs').find.mockReturnValue({ sort });
			getCollection('platformAuditLogs').countDocuments.mockResolvedValue(1);

			const response = await listAuditLogsHandler(buildEvent({
				path: '/platform-admin/audit-logs',
				queryStringParameters: { page: '1', limit: '10' },
			}));

			expect(response.statusCode).toBe(200);
			expect(getCollection('platformAuditLogs').find).toHaveBeenCalledWith(
				expect.objectContaining({
					action: { $ne: 'platform_operator.session_access' },
				}),
			);
		});
	});

	describe('provisionInvite', () => {
		it('creates provision invite and audit log', async () => {
			mockValidOperatorAuth();
			inviteUtils.assertEmailAvailableForProvisionInvite.mockResolvedValue(undefined);
			inviteUtils.createInvitedCognitoUser.mockResolvedValue({ cognitoSub: 'new-sub' });

			const response = await provisionInviteHandler(buildEvent({
				httpMethod: 'POST',
				body: JSON.stringify({ email: 'new@customer.com', name: 'New Admin' }),
			}));

			expect(response.statusCode).toBe(201);
			expect(inviteUtils.createInvitedCognitoUser).toHaveBeenCalledWith(
				expect.objectContaining({ groupName: 'admin', email: 'new@customer.com' }),
			);
		});

		it('returns bad request when email is already in use', async () => {
			mockValidOperatorAuth();
			inviteUtils.assertEmailAvailableForProvisionInvite.mockRejectedValue(
				new inviteUtils.InviteEmailConflictError('This email is already associated with a workspace.'),
			);

			const response = await provisionInviteHandler(buildEvent({
				httpMethod: 'POST',
				body: JSON.stringify({ email: 'taken@customer.com', name: 'Taken' }),
			}));

			expect(response.statusCode).toBe(400);
			const body = JSON.parse(response.body);
			expect(body.message).toContain('workspace');
		});

		it('returns bad request for invalid JSON body', async () => {
			mockValidOperatorAuth();

			const response = await provisionInviteHandler(buildEvent({
				httpMethod: 'POST',
				body: '{not-json',
			}));

			expect(response.statusCode).toBe(500);
		});
	});

	describe('inviteWorkspaceAdmin', () => {
		it('creates workspace admin user and audit log', async () => {
			const workspaceId = new ObjectId();
			mockValidOperatorAuth();

			getCollection('workspaces').findOne.mockResolvedValue({
				_id: workspaceId,
				workspaceName: 'Acme',
				userIds: [],
			});
			getCollection('users').insertOne.mockResolvedValue({ insertedId: new ObjectId() });
			inviteUtils.assertEmailAvailableForWorkspaceAdminInvite.mockResolvedValue(undefined);
			inviteUtils.createInvitedCognitoUser.mockResolvedValue({ cognitoSub: 'admin-sub' });

			const response = await inviteWorkspaceAdminHandler(buildEvent({
				httpMethod: 'POST',
				pathParameters: { workspaceId: workspaceId.toString() },
				body: JSON.stringify({ email: 'admin@acme.com', name: 'Acme Admin' }),
			}));

			expect(response.statusCode).toBe(201);
			expect(getCollection('users').insertOne).toHaveBeenCalled();
		});

		it('returns bad request when email belongs to another workspace', async () => {
			const workspaceId = new ObjectId();
			mockValidOperatorAuth();

			getCollection('workspaces').findOne.mockResolvedValue({
				_id: workspaceId,
				workspaceName: 'Acme',
			});
			inviteUtils.assertEmailAvailableForWorkspaceAdminInvite.mockRejectedValue(
				new inviteUtils.InviteEmailConflictError('This email belongs to a different workspace and cannot be invited here.'),
			);

			const response = await inviteWorkspaceAdminHandler(buildEvent({
				httpMethod: 'POST',
				pathParameters: { workspaceId: workspaceId.toString() },
				body: JSON.stringify({ email: 'other@workspace.com', name: 'Other' }),
			}));

			expect(response.statusCode).toBe(400);
			const body = JSON.parse(response.body);
			expect(body.message).toContain('different workspace');
		});
	});

	describe('billing account updates', () => {
		it('rejects enabling SSO when usage limits do not allow it', async () => {
			const workspaceId = new ObjectId();
			const billingAccountId = new ObjectId();
			mockValidOperatorAuth();

			getCollection('workspaces').findOne.mockResolvedValue({
				_id: workspaceId,
				workspaceName: 'Acme',
			});
			getCollection('billingAccounts').findOne.mockResolvedValue({
				_id: billingAccountId,
				workspaceId,
				status: 'active',
				meteringEnabled: true,
				billingCadence: 'monthly',
				currency: 'USD',
				netTermDays: 30,
				paymentMode: 'offline_wire',
				periodStart: new Date(),
				periodEnd: new Date(),
				usageLimits: { seats: 5, exports: 100, uploadGb: 10, ssoAllowed: false },
				workspacePreferences: { enforcementMode: 'block' },
				sso: { enabled: false },
				pastDue: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			const response = await updateBillingAccountHandler(buildEvent({
				httpMethod: 'PUT',
				pathParameters: { workspaceId: workspaceId.toString() },
				body: JSON.stringify({ ssoEnabled: true }),
			}));

			expect(response.statusCode).toBe(400);
			expect(getCollection('billingAccounts').findOneAndUpdate).not.toHaveBeenCalled();
		});

		it('rejects fractional seat limits', async () => {
			const workspaceId = new ObjectId();
			mockValidOperatorAuth();

			getCollection('workspaces').findOne.mockResolvedValue({
				_id: workspaceId,
				workspaceName: 'Acme',
			});
			getCollection('billingAccounts').findOne.mockResolvedValue({
				_id: new ObjectId(),
				workspaceId,
				status: 'active',
				meteringEnabled: true,
				billingCadence: 'monthly',
				currency: 'USD',
				netTermDays: 30,
				paymentMode: 'offline_wire',
				usageLimits: { seats: 5, exports: 100, uploadGb: 10, ssoAllowed: false },
				workspacePreferences: { enforcementMode: 'block' },
				sso: { enabled: false },
				pastDue: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			const response = await updateBillingAccountHandler(buildEvent({
				httpMethod: 'PUT',
				pathParameters: { workspaceId: workspaceId.toString() },
				body: JSON.stringify({ usageLimits: { seats: 2.5 } }),
			}));

			expect(response.statusCode).toBe(400);
			const body = JSON.parse(response.body);
			expect(body.message).toContain('whole number');
		});
	});

	describe('usage adjustments', () => {
		it('rejects legacy seat-month adjustments', async () => {
			const workspaceId = new ObjectId();
			mockValidOperatorAuth();

			const response = await createUsageAdjustmentHandler(buildEvent({
				httpMethod: 'POST',
				pathParameters: { workspaceId: workspaceId.toString() },
				body: JSON.stringify({ metric: 'activated_seat_month', quantityDelta: 1 }),
			}));

			expect(response.statusCode).toBe(400);
			expect(getCollection('usageAdjustments').insertOne).not.toHaveBeenCalled();
		});
	});
});
