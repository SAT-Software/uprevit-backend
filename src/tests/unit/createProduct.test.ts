import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
}));

jest.mock('../../utils/auditLogV2', () => ({
	recordAuditEvent: jest.fn(async () => undefined),
}));

jest.mock('../../utils/productAccess', () => ({
	findActiveWorkspaceMember: jest.fn(),
}));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;

const { lambdaHandler } = require('../../controllers/products/createProduct');

const workspaceId = new ObjectId();

const buildEvent = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
	httpMethod: 'POST',
	path: '/products',
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

const productInput = (planNumber: unknown) => ({
	project_id: new ObjectId().toString(),
	department_id: new ObjectId().toString(),
	product_plan_number: planNumber,
	product_name: 'Widget',
	product_description: 'A widget',
	version: 1,
});

describe('createProduct plan number check', () => {
	let findOne: jest.Mock<(filter: Record<string, any>) => Promise<unknown>>;
	let insertOne: jest.Mock<() => Promise<unknown>>;
	let updateOne: jest.Mock<() => Promise<unknown>>;

	beforeEach(() => {
		jest.clearAllMocks();
		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId, userId: new ObjectId() },
			auth: { payload: { sub: 'user-sub' } },
		});
		findOne = jest.fn(async () => null);
		insertOne = jest.fn(async () => ({ insertedId: new ObjectId() }));
		updateOne = jest.fn(async () => ({ acknowledged: true }));
		dbModule.getDb.mockResolvedValue({
			collection: jest.fn((name: string) => (name === 'projects'
				? { findOne: jest.fn(async () => ({ _id: new ObjectId(), department_id: new ObjectId(), isArchived: false })) }
				: { findOne, insertOne, updateOne, deleteOne: jest.fn(async () => ({ deletedCount: 1 })) })),
		});
	});

	it('checks duplicates in the caller workspace, case-insensitively', async () => {
		findOne.mockResolvedValue({ _id: new ObjectId() });

		const response = await lambdaHandler(buildEvent(productInput(' abc-1 ')));

		expect(response.statusCode).toBe(409);
		const filter = findOne.mock.calls[0][0];
		expect(filter.workspace_id).toBe(workspaceId);
		expect(filter.product_plan_number).toEqual({ $regex: '^abc-1$', $options: 'i' });
		expect(insertOne).not.toHaveBeenCalled();
	});

	it('escapes the plan number and stores it trimmed', async () => {
		const response = await lambdaHandler(buildEvent(productInput(' A.1 ')));

		expect(response.statusCode).toBe(201);
		expect(findOne.mock.calls[0][0].product_plan_number.$regex).toBe('^A\\.1$');
		expect((insertOne.mock.calls[0] as any[])[0].product_plan_number).toBe('A.1');
	});

	it('rejects a non-string plan number', async () => {
		const response = await lambdaHandler(buildEvent(productInput({ $ne: null })));

		expect(response.statusCode).toBe(400);
		expect(findOne).not.toHaveBeenCalled();
	});

	it('rejects a create while another create or import holds the workspace lock', async () => {
		updateOne.mockRejectedValue({ code: 11000 });

		const response = await lambdaHandler(buildEvent(productInput('ABC-1')));

		expect(response.statusCode).toBe(409);
		expect(findOne).not.toHaveBeenCalled();
		expect(insertOne).not.toHaveBeenCalled();
	});
});
