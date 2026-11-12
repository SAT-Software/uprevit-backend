import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

process.env.AWS_REGION = 'us-east-1';
process.env.UPLOADS_BUCKET = 'uploads-bucket';
process.env.EXPORTS_BUCKET = 'exports-bucket';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
	tenantObjectIdFilter: jest.fn((id: ObjectId) => ({ _id: id })),
}));

jest.mock('../../utils/auditLogV2', () => ({
	recordAuditEvent: jest.fn(async () => undefined),
}));

jest.mock('../../utils/billing/enforcement', () => ({
	assertUsageActionAllowed: jest.fn(async () => ({ allowed: true })),
	checkUploadWouldExceedLimit: jest.fn(async () => ({ allowed: true })),
}));

jest.mock('../../utils/billing/billingAccounts', () => ({
	getBillingAccountByWorkspaceId: jest.fn(),
	normalizeLimits: jest.fn((account: { limits?: { enabled?: boolean } }) => ({
		enabled: account?.limits?.enabled ?? false,
		enforcementMode: 'overage',
		seats: 5,
		exports: 100,
		uploadGb: 10,
		ssoAllowed: false,
	})),
}));

jest.mock('../../utils/billing/uploadCommit', () => ({
	recordCommittedUploadBytes: jest.fn(async () => undefined),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;
const billingAccounts = jest.requireMock('../../utils/billing/billingAccounts') as any;

const { lambdaHandler } = require('../../controllers/sourceFiles/createSourceFileAndFolder');

const workspaceId = new ObjectId();

const buildEvent = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
	httpMethod: 'POST',
	path: '/source-files',
	headers: { Authorization: 'Bearer token' },
	body: JSON.stringify(body),
	pathParameters: null,
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
} as APIGatewayProxyEvent);

describe('createSourceFileAndFolder', () => {
	let findOne: jest.Mock<(filter: Record<string, unknown>) => Promise<unknown>>;
	let insertOne: jest.Mock<(doc: Record<string, unknown>) => Promise<unknown>>;

	beforeEach(() => {
		jest.clearAllMocks();

		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId },
			auth: { payload: { sub: 'user-sub' } },
		});

		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			limits: { enabled: true },
		});

		findOne = jest.fn(async () => null);
		insertOne = jest.fn(async () => ({ insertedId: new ObjectId() }));
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({ findOne, insertOne })),
		});
	});

	const validKey = () => `uploads/${workspaceId.toString()}/source-files/spec.pdf`;

	it('requires sizeBytes for file uploads when metering is enabled', async () => {
		const response = await lambdaHandler(buildEvent({
			name: 'spec.pdf',
			type: 'file',
			key: validKey(),
		}));

		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.message).toContain('sizeBytes');
	});

	it.each([
		['another workspace', { key: `uploads/${new ObjectId().toString()}/source-files/x.pdf` }],
		['outside source-files', { key: `uploads/${workspaceId.toString()}/workspace/logo.png` }],
		['url only', { url: 'https://example.com/x.pdf' }],
	])('rejects a file key from %s', async (_label, keyFields) => {
		const response = await lambdaHandler(buildEvent({ name: 'x.pdf', type: 'file', sizeBytes: 10, ...keyFields }));

		expect(response.statusCode).toBe(400);
		expect(insertOne).not.toHaveBeenCalled();
	});

	it('stores the key and never a client url', async () => {
		const response = await lambdaHandler(buildEvent({
			name: 'spec.pdf',
			type: 'file',
			key: validKey(),
			url: 'https://example.com/pixel.png',
			sizeBytes: 10,
		}));

		expect(response.statusCode).toBe(201);
		const inserted = insertOne.mock.calls[0][0];
		expect(inserted.key).toBe(validKey());
		expect(inserted).not.toHaveProperty('url');
	});

	it('rejects a key that is already registered', async () => {
		findOne.mockImplementation(async (filter) => ('key' in filter ? { _id: new ObjectId() } : null));

		const response = await lambdaHandler(buildEvent({ name: 'spec.pdf', type: 'file', key: validKey(), sizeBytes: 10 }));

		expect(response.statusCode).toBe(409);
		expect(insertOne).not.toHaveBeenCalled();
	});
});
