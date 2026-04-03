import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/authUtils', () => ({
	authenticateRequest: jest.fn(),
}));

const authUtils = jest.requireMock('../../utils/authUtils') as any;
const authenticateRequest = authUtils.authenticateRequest;

const { lambdaHandler } = require('../../app');

describe('Unit test for app handler', function () {
	beforeEach(() => {
		jest.clearAllMocks();
		authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: { sub: 'user-sub' },
			token: 'token',
		});
	});

	it('verifies successful response', async () => {
		const event: APIGatewayProxyEvent = {
			httpMethod: 'get',
			body: '',
			headers: { Authorization: 'Bearer token' },
			isBase64Encoded: false,
			multiValueHeaders: {},
			multiValueQueryStringParameters: {},
			path: '/hello',
			pathParameters: {},
			queryStringParameters: {},
			requestContext: {
				accountId: '123456789012',
				apiId: '1234',
				authorizer: {},
				httpMethod: 'get',
				identity: {
					accessKey: '',
					accountId: '',
					apiKey: '',
					apiKeyId: '',
					caller: '',
					clientCert: {
						clientCertPem: '',
						issuerDN: '',
						serialNumber: '',
						subjectDN: '',
						validity: { notAfter: '', notBefore: '' },
					},
					cognitoAuthenticationProvider: '',
					cognitoAuthenticationType: '',
					cognitoIdentityId: '',
					cognitoIdentityPoolId: '',
					principalOrgId: '',
					sourceIp: '',
					user: '',
					userAgent: '',
					userArn: '',
				},
				path: '/hello',
				protocol: 'HTTP/1.1',
				requestId: 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef',
				requestTimeEpoch: 1428582896000,
				resourceId: '123456',
				resourcePath: '/hello',
				stage: 'dev',
			},
			resource: '',
			stageVariables: {},
		};
		const result: APIGatewayProxyResult = await lambdaHandler(event);

		expect(result.statusCode).toEqual(200);
		expect(JSON.parse(result.body)).toEqual(expect.objectContaining({
			message: 'Hello from Lambda!',
			database: 'Connected successfully',
		}));
	});
});
