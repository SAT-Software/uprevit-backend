import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

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
	beforeEach(() => {
		jest.clearAllMocks();

		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId },
			auth: { payload: { sub: 'user-sub' } },
		});

		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			meteringEnabled: true,
		});

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({
				findOne: jest.fn(async () => null),
				insertOne: jest.fn(async () => ({ insertedId: new ObjectId() })),
			})),
		});
	});

	it('requires sizeBytes for file uploads when metering is enabled', async () => {
		const response = await lambdaHandler(buildEvent({
			name: 'spec.pdf',
			type: 'file',
			key: 'uploads/ws/source-files/spec.pdf',
		}));

		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.message).toContain('sizeBytes');
	});
});
