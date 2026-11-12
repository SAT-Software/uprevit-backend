import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
	assertWorkspaceMatch: jest.fn(() => null),
	isWorkspaceAdmin: jest.fn((groups: string[]) => groups.includes('admin')),
}));
jest.mock('../../utils/s3-storage', () => ({
	enrichUsersWithProfileAvatarUrls: jest.fn(async (users: unknown[]) => users),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;

const { lambdaHandler } = require('../../controllers/auditLogs/getAuditLogs');

const workspaceId = new ObjectId();

const buildCollection = () => {
	const toArray = jest.fn(async () => []);
	const chain: Record<string, unknown> = { toArray };
	chain.sort = jest.fn(() => chain);
	chain.skip = jest.fn(() => chain);
	chain.limit = jest.fn(() => chain);
	return { find: jest.fn(() => chain), countDocuments: jest.fn(async () => 0), findOne: jest.fn(), createIndex: jest.fn(async () => 'index') };
};

const buildEvent = (queryStringParameters: Record<string, string>): APIGatewayProxyEvent => ({
	httpMethod: 'GET',
	path: '/audit-logs',
	headers: { Authorization: 'Bearer token' },
	body: null,
	pathParameters: null,
	queryStringParameters,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
} as APIGatewayProxyEvent);

const asUser = (groups: string[]) => {
	tenantContext.requireTenantContext.mockResolvedValue({
		ok: true,
		context: { workspaceId, userId: new ObjectId(), cognitoSub: 'sub-1', cognitoGroups: groups },
		auth: { payload: { sub: 'sub-1', 'cognito:groups': groups } },
	});
};

const message = (response: { body: string }) => JSON.parse(response.body).message;

describe('getAuditLogs workspace scope', () => {
	let collection: ReturnType<typeof buildCollection>;

	beforeEach(() => {
		jest.clearAllMocks();
		collection = buildCollection();
		dbModule.getDb.mockResolvedValue({ collection: () => collection });
		asUser(['admin']);
	});

	it('returns every event in the workspace for an admin', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace' }));

		expect(response.statusCode).toBe(200);
		const filter = (collection.find.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(filter.workspaceId).toBe(workspaceId);
		expect(filter).not.toHaveProperty(['scope.type']);
		expect(filter).not.toHaveProperty(['scope.id']);
		expect(filter).not.toHaveProperty('visibility');
	});

	it('forbids the workspace scope for a non-admin', async () => {
		asUser(['user']);
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace' }));

		expect(response.statusCode).toBe(403);
		expect(message(response)).toBe('Insufficient permissions to view this log scope.');
	});

	it('still requires scopeId for a record scope', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'product' }));

		expect(response.statusCode).toBe(400);
		expect(message(response)).toBe('scopeId query parameter is required for this scope type.');
	});

	it('filters by actions', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace', actions: 'archive,update' }));

		expect(response.statusCode).toBe(200);
		expect(collection.find).toHaveBeenCalledWith(expect.objectContaining({ action: { $in: ['archive', 'update'] } }));
	});

	it('rejects an unknown action', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace', actions: 'bogus' }));

		expect(response.statusCode).toBe(400);
		expect(message(response)).toBe('Invalid action filter: bogus');
	});

	it('filters by entity type and rejects an unknown one', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace', entityType: 'user' }));
		expect(response.statusCode).toBe(200);
		expect(collection.find).toHaveBeenCalledWith(expect.objectContaining({ 'entity.type': 'user' }));

		const invalid = await lambdaHandler(buildEvent({ scopeType: 'workspace', entityType: 'bogus' }));
		expect(invalid.statusCode).toBe(400);
	});

	it('filters by actor', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace', actorUserId: 'sub-9' }));

		expect(response.statusCode).toBe(200);
		expect(collection.find).toHaveBeenCalledWith(expect.objectContaining({ 'actor.userId': 'sub-9' }));
	});

	it('filters by date range and rejects an invalid date', async () => {
		const response = await lambdaHandler(buildEvent({ scopeType: 'workspace', from: '2026-01-01', to: '2026-01-31' }));
		expect(response.statusCode).toBe(200);
		expect(collection.find).toHaveBeenCalledWith(expect.objectContaining({
			occurredAt: { $gte: new Date('2026-01-01'), $lte: new Date('2026-01-31') },
		}));

		const invalid = await lambdaHandler(buildEvent({ scopeType: 'workspace', from: 'not-a-date' }));
		expect(invalid.statusCode).toBe(400);
	});

	it('keeps the archive scope admin-only', async () => {
		asUser(['user']);
		const response = await lambdaHandler(buildEvent({ scopeType: 'archive' }));

		expect(response.statusCode).toBe(403);
	});
});
