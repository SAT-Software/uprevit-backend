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

jest.mock('../../utils/s3-storage', () => ({
	...(jest.requireActual('../../utils/s3-storage') as object),
	headUploadObject: jest.fn(),
}));

jest.mock('../../utils/billing/uploadCommit', () => ({
	recordCommittedUploadBytes: jest.fn(async () => undefined),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;
const s3Storage = jest.requireMock('../../utils/s3-storage') as any;

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

		s3Storage.headUploadObject.mockResolvedValue({ contentType: 'application/pdf', sizeBytes: 777 });

		findOne = jest.fn(async () => null);
		insertOne = jest.fn(async () => ({ insertedId: new ObjectId() }));
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({ findOne, insertOne })),
		});
	});

	const validKey = () => `uploads/${workspaceId.toString()}/source-files/spec.pdf`;

	it('rejects a file that was not uploaded', async () => {
		s3Storage.headUploadObject.mockResolvedValue(null);

		const response = await lambdaHandler(buildEvent({ name: 'spec.pdf', type: 'file', key: validKey() }));

		expect(response.statusCode).toBe(400);
		expect(insertOne).not.toHaveBeenCalled();
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
			sizeBytes: 1,
		}));

		expect(response.statusCode).toBe(201);
		const inserted = insertOne.mock.calls[0][0];
		expect(inserted.key).toBe(validKey());
		expect(inserted.sizeBytes).toBe(777);
		expect(inserted).not.toHaveProperty('url');
	});

	it('rejects a key that is already registered', async () => {
		findOne.mockImplementation(async (filter) => ('key' in filter ? { _id: new ObjectId() } : null));

		const response = await lambdaHandler(buildEvent({ name: 'spec.pdf', type: 'file', key: validKey(), sizeBytes: 10 }));

		expect(response.statusCode).toBe(409);
		expect(insertOne).not.toHaveBeenCalled();
	});

	it('returns a conflict when a concurrent request registered the key first', async () => {
		insertOne.mockRejectedValue({ code: 11000 });

		const response = await lambdaHandler(buildEvent({ name: 'spec.pdf', type: 'file', key: validKey(), sizeBytes: 10 }));

		expect(response.statusCode).toBe(409);
	});
});
