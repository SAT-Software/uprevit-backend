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
	tenantObjectIdFilter: jest.fn((id: string) => ({ _id: id })),
}));

jest.mock('../../utils/auditLogV2', () => ({
	recordAuditEvent: jest.fn(async () => undefined),
}));

jest.mock('../../utils/sourceFilesAudit', () => ({
	resolveWorkspaceProductName: jest.fn(async () => null),
}));

jest.mock('../../utils/s3-storage', () => ({
	...(jest.requireActual('../../utils/s3-storage') as object),
	deleteObjectByKey: jest.fn(async () => undefined),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;
const s3Storage = jest.requireMock('../../utils/s3-storage') as any;

const { lambdaHandler } = require('../../controllers/sourceFiles/deleteSourceFileAndFolder');

const workspaceId = new ObjectId();

const buildEvent = (id: string): APIGatewayProxyEvent => ({
	httpMethod: 'DELETE',
	path: `/source-files/${id}`,
	headers: { Authorization: 'Bearer token' },
	body: null,
	pathParameters: { id },
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
} as APIGatewayProxyEvent);

describe('deleteSourceFileAndFolder', () => {
	let deleteMany: jest.Mock<() => Promise<unknown>>;

	const mockFile = (key: string) => {
		const file = { _id: new ObjectId(), workspace_id: workspaceId, type: 'file', name: 'a.pdf', parentId: null, key };
		deleteMany = jest.fn(async () => ({ deletedCount: 1 }));
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({
				findOne: jest.fn(async () => file),
				find: jest.fn(() => ({ toArray: jest.fn(async () => [file]) })),
				deleteMany,
			})),
		});
		return file;
	};

	beforeEach(() => {
		jest.clearAllMocks();
		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId },
			auth: { payload: { sub: 'user-sub' } },
		});
	});

	it('deletes an object inside the workspace', async () => {
		const key = `uploads/${workspaceId.toString()}/source-files/a.pdf`;
		const file = mockFile(key);

		const response = await lambdaHandler(buildEvent(file._id.toString()));

		expect(response.statusCode).toBe(200);
		expect(s3Storage.deleteObjectByKey).toHaveBeenCalledTimes(1);
		expect(s3Storage.deleteObjectByKey).toHaveBeenCalledWith(key);
		expect(deleteMany).toHaveBeenCalledTimes(1);
	});

	it('skips an object outside the workspace but still removes the record', async () => {
		const file = mockFile(`uploads/${new ObjectId().toString()}/source-files/b.pdf`);

		const response = await lambdaHandler(buildEvent(file._id.toString()));

		expect(response.statusCode).toBe(200);
		expect(s3Storage.deleteObjectByKey).not.toHaveBeenCalled();
		expect(deleteMany).toHaveBeenCalledTimes(1);
	});
});
