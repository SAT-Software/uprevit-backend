import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
	assertWorkspaceMatch: jest.fn(),
}));

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/reports/queryBuilder', () => ({
	validateConditions: jest.fn(),
	buildAggregationPipeline: jest.fn(),
}));

const tenantContext = jest.requireMock('../../utils/tenantContext') as any;
const dbModule = jest.requireMock('../../utils/db') as any;
const queryBuilder = jest.requireMock('../../utils/reports/queryBuilder') as any;

const requireTenantContext = tenantContext.requireTenantContext;
const assertWorkspaceMatch = tenantContext.assertWorkspaceMatch;
const getDb = dbModule.getDb;
const buildAggregationPipeline = queryBuilder.buildAggregationPipeline;

const { lambdaHandler } = require('../../controllers/reports/reportsQuery');

describe('reportsQuery', () => {
	const workspaceId = new ObjectId();

	beforeEach(() => {
		jest.clearAllMocks();

		requireTenantContext.mockResolvedValue({
			ok: true,
			context: {
				workspaceId,
				userId: new ObjectId(),
				cognitoSub: 'user-sub',
				cognitoGroups: ['user'],
			},
		});

		assertWorkspaceMatch.mockReturnValue(null);

		buildAggregationPipeline.mockReturnValue([]);

		getDb.mockResolvedValue({
			collection: () => ({
				aggregate: () => ({
					toArray: async () => [{ data: [], metadata: [{ total: 0 }] }],
				}),
			}),
		});
	});

	it('runs the aggregation pipeline for the authenticated workspace', async () => {
		const response = await lambdaHandler({
			body: JSON.stringify({
				workspaceId: workspaceId.toString(),
				conditions: [],
			}),
			headers: { Authorization: 'Bearer token' },
		} as any);

		expect(response.statusCode).toBe(200);
		expect(assertWorkspaceMatch).toHaveBeenCalledWith(
			workspaceId.toString(),
			workspaceId,
			'You are not authorized to query reports for this workspace',
		);
		expect(buildAggregationPipeline).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: workspaceId.toString() }),
			workspaceId,
		);
	});

	it('rejects queries for a different workspace', async () => {
		assertWorkspaceMatch.mockReturnValue({
			statusCode: 403,
			body: JSON.stringify({ message: 'You are not authorized to query reports for this workspace' }),
		});

		const response = await lambdaHandler({
			body: JSON.stringify({
				workspaceId: new ObjectId().toString(),
				conditions: [],
			}),
			headers: { Authorization: 'Bearer token' },
		} as any);

		expect(response.statusCode).toBe(403);
		expect(buildAggregationPipeline).not.toHaveBeenCalled();
	});
});
