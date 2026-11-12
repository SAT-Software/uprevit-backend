import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/authUtils', () => ({
	authenticateRequest: jest.fn(async () => ({ isValid: true, payload: { sub: 'sub-1', 'cognito:groups': ['admin'] } })),
}));

jest.mock('../../utils/authenticatedUser', () => ({
	getAuthenticatedUserContext: jest.fn(),
}));

jest.mock('../../utils/billing/enforcement', () => ({
	assertUsageActionAllowed: jest.fn(async () => ({ allowed: true })),
	checkUploadWouldExceedLimit: jest.fn(async () => ({ allowed: true })),
}));

jest.mock('../../utils/s3-storage', () => ({
	...(jest.requireActual('../../utils/s3-storage') as object),
	createPresignedUrl: jest.fn(async () => ({ uploadUrl: 'u', key: 'k' })),
}));

const authenticatedUser = jest.requireMock('../../utils/authenticatedUser') as any;
const s3Storage = jest.requireMock('../../utils/s3-storage') as any;

const { lambdaHandler } = require('../../controllers/s3Storage/presignUpload');

const buildEvent = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
	httpMethod: 'POST',
	path: '/s3-storage/presign-upload',
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

const upload = (sizeBytes?: unknown) => buildEvent({ fileName: 'logo.png', contentType: 'image/png', uploadScope: 'workspace-assets', sizeBytes });

describe('presignUpload', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authenticatedUser.getAuthenticatedUserContext.mockResolvedValue({ workspaceId: new ObjectId(), userId: new ObjectId() });
	});

	it.each([
		['missing', undefined],
		['fractional', 1.5],
		['over the cap', 10 * 1024 * 1024 + 1],
	])('rejects a %s size', async (_label, sizeBytes) => {
		const response = await lambdaHandler(upload(sizeBytes));

		expect(response.statusCode).toBe(400);
		expect(s3Storage.createPresignedUrl).not.toHaveBeenCalled();
	});

	it('signs the upload with the requested size', async () => {
		const response = await lambdaHandler(upload(1000));

		expect(response.statusCode).toBe(201);
		expect(s3Storage.createPresignedUrl).toHaveBeenCalledWith('logo.png', 'image/png', expect.objectContaining({ sizeBytes: 1000 }));
	});
});
