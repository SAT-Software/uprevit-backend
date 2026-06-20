import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
	isWorkspaceAdmin: jest.fn(),
}));

jest.mock('../../utils/billing/billingAccounts', () => ({
	getBillingAccountByWorkspaceId: jest.fn(),
	normalizeLimits: jest.fn(),
	limitsToUsageLimits: (limits: {
		seats: number;
		exports: number;
		uploadGb: number;
		ssoAllowed: boolean;
	}) => ({
		seats: limits.seats,
		exports: limits.exports,
		uploadGb: limits.uploadGb,
		ssoAllowed: limits.ssoAllowed,
	}),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;
const billingAccounts = jest.requireMock('../../utils/billing/billingAccounts') as any;

const { lambdaHandler } = require('../../controllers/billing/updatePreferences');

const workspaceId = new ObjectId();
const billingAccountId = new ObjectId();

const buildEvent = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
	httpMethod: 'PUT',
	path: '/billing/preferences',
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

describe('updatePreferences', () => {
	const findOneAndUpdate = jest.fn();

	beforeEach(() => {
		jest.clearAllMocks();

		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId, cognitoGroups: ['workspace-admin'] },
		});
		tenantContext.isWorkspaceAdmin.mockReturnValue(true);

		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			_id: billingAccountId,
			workspaceId,
		});
		billingAccounts.normalizeLimits.mockReturnValue({
			enabled: true,
			enforcementMode: 'overage',
			seats: 5,
			exports: 100,
			uploadGb: 10,
			ssoAllowed: false,
		});

		findOneAndUpdate.mockResolvedValue({
			_id: billingAccountId,
			workspaceId,
			status: 'active',
			limits: {
				enabled: true,
				enforcementMode: 'block',
				seats: 5,
				exports: 50,
				uploadGb: 5,
				ssoAllowed: false,
			},
			billingCadence: 'monthly',
			currency: 'USD',
			netTermDays: 30,
			paymentMode: 'offline_wire',
			sso: { enabled: false },
			pastDue: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		dbModule.getDb.mockResolvedValue({
			collection: jest.fn(() => ({
				findOneAndUpdate,
			})),
		});
	});

	it('updates enforcement mode and limits for workspace admins', async () => {
		const response = await lambdaHandler(buildEvent({
			enforcementMode: 'block',
			exports: 50,
			uploadGb: 5,
		}));

		expect(response.statusCode).toBe(200);
		expect(findOneAndUpdate).toHaveBeenCalledWith(
			{ _id: billingAccountId },
			expect.objectContaining({
				$set: expect.objectContaining({
					limits: expect.objectContaining({
						enforcementMode: 'block',
						exports: 50,
						uploadGb: 5,
						seats: 5,
					}),
				}),
			}),
			{ returnDocument: 'after' },
		);
	});

	it('rejects non-workspace admins', async () => {
		tenantContext.isWorkspaceAdmin.mockReturnValue(false);

		const response = await lambdaHandler(buildEvent({ enforcementMode: 'block' }));

		expect(response.statusCode).toBe(403);
	});

	it('validates enforcement mode', async () => {
		const response = await lambdaHandler(buildEvent({ enforcementMode: 'invalid' }));

		expect(response.statusCode).toBe(400);
	});
});
