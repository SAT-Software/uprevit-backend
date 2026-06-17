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
	parseCognitoGroups: (groups: unknown) => (Array.isArray(groups) ? groups : []),
}));

jest.mock('../../utils/billing/billingAccounts', () => ({
	getBillingAccountByWorkspaceId: jest.fn(),
}));

jest.mock('../../utils/billing/serializers', () => ({
	serializeBillingAccount: jest.fn((account: unknown) => account),
}));

jest.mock('../../utils/billing/chargebeeClient', () => ({
	createChargebeeCustomer: jest.fn(),
	retrieveChargebeeCustomer: jest.fn(),
	isChargebeeDuplicateCustomerError: jest.fn(),
}));

jest.mock('../../config/chargebeeConfig', () => ({
	isChargebeeConfigured: jest.fn(),
}));

const authUtils = jest.requireMock('../../utils/authUtils') as any;
const dbModule = jest.requireMock('../../utils/db') as any;
const auditLog = jest.requireMock('../../utils/platformAuditLog') as any;
const billingAccounts = jest.requireMock('../../utils/billing/billingAccounts') as any;
const chargebeeClient = jest.requireMock('../../utils/billing/chargebeeClient') as any;
const chargebeeConfig = jest.requireMock('../../config/chargebeeConfig') as any;

const { lambdaHandler: createChargebeeCustomerHandler } = require('../../controllers/platformAdmin/createChargebeeCustomer');

const workspaceId = new ObjectId();
const billingAccountId = new ObjectId();
const customerId = `ws_${workspaceId.toString()}`;

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
	workspaceId,
};

const baseBillingAccount = {
	_id: billingAccountId,
	workspaceId,
	status: 'active',
	limits: {
		enabled: true,
		enforcementMode: 'overage',
		seats: 5,
		exports: 100,
		uploadGb: 10,
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
};

const buildEvent = (overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
	httpMethod: 'POST',
	path: `/platform-admin/workspaces/${workspaceId.toString()}/billing/chargebee/customer`,
	headers: { Authorization: 'Bearer token' },
	body: JSON.stringify({ email: 'billing@acme.com' }),
	pathParameters: { workspaceId: workspaceId.toString() },
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
	...overrides,
} as APIGatewayProxyEvent);

describe('createChargebeeCustomer', () => {
	type CollectionMocks = Record<string, {
		findOne: ReturnType<typeof jest.fn>;
		updateOne: ReturnType<typeof jest.fn>;
	}>;

	let getCollection: (name: string) => CollectionMocks[string];

	beforeEach(() => {
		jest.clearAllMocks();

		const collections: CollectionMocks = {};
		getCollection = (name: string) => {
			if (!collections[name]) {
				collections[name] = {
					findOne: jest.fn(),
					updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 } as never),
				};
			}
			return collections[name];
		};

		dbModule.getDb.mockResolvedValue({ collection: jest.fn((name: string) => getCollection(name)) });

		authUtils.authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: { sub: 'platform-sub', 'cognito:groups': ['platform-admin'] },
			token: 'token',
		});
		getCollection('platformAdmins').findOne.mockResolvedValue(activeOperator);
		getCollection('users').findOne.mockResolvedValue(activeWorkspaceUser);
		getCollection('workspaces').findOne.mockResolvedValue({
			_id: workspaceId,
			workspaceName: 'Acme',
		});

		chargebeeConfig.isChargebeeConfigured.mockReturnValue(true);
		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue(baseBillingAccount);
		chargebeeClient.createChargebeeCustomer.mockResolvedValue({
			id: customerId,
			company: 'Acme',
			email: 'billing@acme.com',
		});
		chargebeeClient.isChargebeeDuplicateCustomerError.mockReturnValue(false);
	});

	it('creates a Chargebee customer and links it to the billing account', async () => {
		const linkedAccount = {
			...baseBillingAccount,
			chargebee: { customerId, lastSyncedAt: new Date() },
		};
		billingAccounts.getBillingAccountByWorkspaceId
			.mockResolvedValueOnce(baseBillingAccount)
			.mockResolvedValueOnce(linkedAccount);

		const response = await createChargebeeCustomerHandler(buildEvent());
		const body = JSON.parse(response.body);

		expect(response.statusCode).toBe(201);
		expect(body.message).toBe('Chargebee customer created');
		expect(chargebeeClient.createChargebeeCustomer).toHaveBeenCalledWith({
			id: customerId,
			company: 'Acme',
			email: 'billing@acme.com',
		});
		expect(chargebeeClient.retrieveChargebeeCustomer).not.toHaveBeenCalled();
		expect(getCollection('billingAccounts').updateOne).toHaveBeenCalledWith(
			{ _id: billingAccountId },
			expect.objectContaining({
				$set: expect.objectContaining({
					chargebee: expect.objectContaining({ customerId }),
				}),
			}),
		);
	});

	it('retrieves and links an existing Chargebee customer on duplicate create', async () => {
		const duplicateError = new Error(JSON.stringify({
			api_error_code: 'duplicate_entry',
			error_code: 'param_not_unique',
		}));
		chargebeeClient.createChargebeeCustomer.mockRejectedValue(duplicateError);
		chargebeeClient.isChargebeeDuplicateCustomerError.mockReturnValue(true);
		chargebeeClient.retrieveChargebeeCustomer.mockResolvedValue({
			id: customerId,
			company: 'Acme',
			email: 'billing@acme.com',
		});

		const linkedAccount = {
			...baseBillingAccount,
			chargebee: { customerId, lastSyncedAt: new Date() },
		};
		billingAccounts.getBillingAccountByWorkspaceId
			.mockResolvedValueOnce(baseBillingAccount)
			.mockResolvedValueOnce(linkedAccount);

		const response = await createChargebeeCustomerHandler(buildEvent());
		const body = JSON.parse(response.body);

		expect(response.statusCode).toBe(201);
		expect(body.message).toBe('Chargebee customer linked');
		expect(chargebeeClient.retrieveChargebeeCustomer).toHaveBeenCalledWith(customerId);
		expect(getCollection('billingAccounts').updateOne).toHaveBeenCalledWith(
			{ _id: billingAccountId },
			expect.objectContaining({
				$set: expect.objectContaining({
					chargebee: expect.objectContaining({ customerId }),
				}),
			}),
		);
		expect(auditLog.recordPlatformAuditEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Linked existing Chargebee customer for Acme',
			}),
		);
	});

	it('returns conflict when the billing account is already linked', async () => {
		billingAccounts.getBillingAccountByWorkspaceId.mockResolvedValue({
			...baseBillingAccount,
			chargebee: { customerId },
		});

		const response = await createChargebeeCustomerHandler(buildEvent());

		expect(response.statusCode).toBe(409);
		expect(chargebeeClient.createChargebeeCustomer).not.toHaveBeenCalled();
	});
});
