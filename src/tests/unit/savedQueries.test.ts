import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../../utils/tenantContext', () => ({ requireTenantContext: jest.fn() }));

const dbModule = jest.requireMock('../../utils/db') as any;
const tenantContext = jest.requireMock('../../utils/tenantContext') as any;

const { lambdaHandler: createHandler } = require('../../controllers/reports/createSavedQuery');
const { lambdaHandler: getHandler } = require('../../controllers/reports/getSavedQueries');
const { lambdaHandler: updateHandler } = require('../../controllers/reports/updateSavedQuery');
const { lambdaHandler: deleteHandler } = require('../../controllers/reports/deleteSavedQuery');

const workspaceId = new ObjectId();
const userId = new ObjectId();

const buildEvent = (overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
	httpMethod: 'POST',
	path: '/reports/saved-queries',
	headers: { Authorization: 'Bearer token' },
	body: null,
	pathParameters: null,
	queryStringParameters: null,
	multiValueHeaders: {},
	multiValueQueryStringParameters: null,
	isBase64Encoded: false,
	requestContext: { requestId: 'req-1' } as APIGatewayProxyEvent['requestContext'],
	resource: '',
	stageVariables: null,
	...overrides,
} as APIGatewayProxyEvent);

const createEvent = (body: Record<string, unknown>) => buildEvent({ body: JSON.stringify(body) });

const reportDefinition = {
	conditions: [{ id: 'c1', tab: 'root', field: 'status', operator: 'equals', value: 'draft' }],
	conditionLogic: 'AND',
};

const bodyOf = (result: { body: string }) => JSON.parse(result.body);

describe('saved queries', () => {
	const toArray = jest.fn(async () => [] as unknown[]);
	const limit = jest.fn(() => ({ toArray }));
	const sort = jest.fn(() => ({ limit }));
	const collection = {
		createIndex: jest.fn(async () => 'index'),
		find: jest.fn((_filter: unknown) => ({ sort })),
		findOne: jest.fn(async () => null as unknown),
		insertOne: jest.fn(async (_doc: Record<string, unknown>) => ({ acknowledged: true })),
		findOneAndUpdate: jest.fn(async () => null as unknown),
		deleteOne: jest.fn(async () => ({ deletedCount: 0 })),
		countDocuments: jest.fn(async () => 0),
	};

	beforeEach(() => {
		jest.clearAllMocks();
		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId, userId },
			auth: { payload: { sub: 'user-sub' } },
		});
		dbModule.getDb.mockResolvedValue({ collection: jest.fn(() => collection) });
	});

	it('rejects a report definition with an invalid operator', async () => {
		const result = await createHandler(createEvent({
			kind: 'report',
			name: 'Bad',
			definition: { conditions: [{ ...reportDefinition.conditions[0], operator: 'regex' }] },
		}));
		expect(result.statusCode).toBe(400);
		expect(collection.insertOne).not.toHaveBeenCalled();
	});

	it('rejects a workflow definition with an unknown field', async () => {
		const result = await createHandler(createEvent({
			kind: 'workflow',
			name: 'Bad',
			definition: { conditions: [{ field: 'nope', operator: 'equals', value: 'x' }] },
		}));
		expect(result.statusCode).toBe(400);
		expect(bodyOf(result).message).toBe('Unknown field: nope');
	});

	it('rejects a name longer than 120 characters', async () => {
		const result = await createHandler(createEvent({ kind: 'report', name: 'a'.repeat(121), definition: reportDefinition }));
		expect(result.statusCode).toBe(400);
	});

	it('creates a report query owned by the caller in their workspace', async () => {
		const result = await createHandler(createEvent({ kind: 'report', name: ' Drafts ', definition: reportDefinition }));
		expect(result.statusCode).toBe(201);
		expect(collection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
			workspaceId,
			ownerUserId: userId,
			kind: 'report',
			name: 'Drafts',
			shared: false,
		}));
		expect(bodyOf(result).result.query.isOwner).toBe(true);
	});

	it('lists own and shared queries of the requested kind in the workspace', async () => {
		const result = await getHandler(buildEvent({ httpMethod: 'GET', queryStringParameters: { kind: 'workflow' } }));
		expect(result.statusCode).toBe(200);
		expect(collection.find).toHaveBeenCalledWith({
			workspaceId,
			kind: 'workflow',
			$or: [{ ownerUserId: userId }, { shared: true }],
		});
	});

	it('returns 404 when updating a query the caller does not own', async () => {
		const queryId = new ObjectId();
		const result = await updateHandler(buildEvent({
			httpMethod: 'PUT',
			pathParameters: { queryId: queryId.toString() },
			body: JSON.stringify({ shared: true }),
		}));
		expect(result.statusCode).toBe(404);
		expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
			{ _id: queryId, workspaceId, ownerUserId: userId },
			expect.anything(),
			{ returnDocument: 'after' },
		);
	});

	it('returns 404 when deleting a query the caller does not own', async () => {
		const queryId = new ObjectId();
		const result = await deleteHandler(buildEvent({ httpMethod: 'DELETE', pathParameters: { queryId: queryId.toString() } }));
		expect(result.statusCode).toBe(404);
		expect(collection.deleteOne).toHaveBeenCalledWith({ _id: queryId, workspaceId, ownerUserId: userId });
	});
});
