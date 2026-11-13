import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/tenantContext', () => ({
	requireTenantContext: jest.fn(),
}));

jest.mock('../../utils/exportJobs', () => ({
	getExportJobByIdForUser: jest.fn(),
	isExportStatus: (value: unknown) => ['queued', 'processing', 'completed', 'failed'].includes(value as string),
	listExportJobsForUser: jest.fn(),
}));

jest.mock('../../utils/s3-storage', () => ({
	createExportPresignedGetUrl: jest.fn(async () => 'https://signed.example/file'),
}));

const tenantContext = jest.requireMock('../../utils/tenantContext') as any;
const exportJobs = jest.requireMock('../../utils/exportJobs') as any;

const { lambdaHandler: listProductJobs } = require('../../controllers/products/getProductExportJobs');
const { lambdaHandler: downloadReportJob } = require('../../controllers/reports/downloadReportExportJob');

const workspaceId = new ObjectId();
const event = (overrides: Record<string, unknown> = {}) => ({
	headers: {},
	queryStringParameters: null,
	pathParameters: null,
	...overrides,
});

describe('export job handlers', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		tenantContext.requireTenantContext.mockResolvedValue({
			ok: true,
			context: { workspaceId, cognitoSub: 'user-sub' },
		});
		exportJobs.listExportJobsForUser.mockResolvedValue({
			jobs: [],
			pagination: { page: 1 },
			hasActiveJobs: false,
			activeJobsCount: 0,
		});
	});

	it('lists jobs for the resource targets with parsed filters', async () => {
		const targetId = new ObjectId();
		const response = await listProductJobs(event({
			queryStringParameters: { page: '2', status: 'queued,processing', targetId: targetId.toString() },
		}));

		expect(response.statusCode).toBe(200);
		expect(exportJobs.listExportJobsForUser).toHaveBeenCalledWith({
			requestedBySub: 'user-sub',
			workspaceId,
			target: ['product', 'product_specifications', 'operational_parameters'],
			targetId,
			statuses: ['queued', 'processing'],
			page: 2,
		});
	});

	it('rejects an invalid status filter', async () => {
		const response = await listProductJobs(event({ queryStringParameters: { status: 'queued,done' } }));

		expect(response.statusCode).toBe(400);
		expect(exportJobs.listExportJobsForUser).not.toHaveBeenCalled();
	});

	it('returns 404 for a job outside the resource', async () => {
		exportJobs.getExportJobByIdForUser.mockResolvedValue(null);

		const response = await downloadReportJob(event({ pathParameters: { jobId: new ObjectId().toString() } }));

		expect(response.statusCode).toBe(404);
		expect(exportJobs.getExportJobByIdForUser).toHaveBeenCalledWith(expect.objectContaining({ target: 'report' }));
	});

	it('refuses to sign an expired export', async () => {
		exportJobs.getExportJobByIdForUser.mockResolvedValue({
			_id: new ObjectId(),
			status: 'completed',
			s3Key: 'exports/file.pdf',
			expiresAt: new Date(Date.now() - 1000),
		});

		const response = await downloadReportJob(event({ pathParameters: { jobId: new ObjectId().toString() } }));

		expect(response.statusCode).toBe(400);
	});
});
