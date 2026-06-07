import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/authUtils', () => ({
	authenticateRequest: jest.fn(),
}));

jest.mock('../../utils/authenticatedUser', () => ({
	getAuthenticatedUserContext: jest.fn(),
}));

jest.mock('../../utils/exportJobs', () => ({
	createQueuedExportJob: jest.fn(),
}));

jest.mock('../../utils/exportQueue', () => ({
	enqueueExportJobMessage: jest.fn(),
}));

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/billing/enforcement', () => ({
	assertUsageActionAllowed: jest.fn(async () => ({ allowed: true })),
}));

const authUtils = jest.requireMock('../../utils/authUtils') as any;
const authenticatedUser = jest.requireMock('../../utils/authenticatedUser') as any;
const exportJobs = jest.requireMock('../../utils/exportJobs') as any;
const exportQueue = jest.requireMock('../../utils/exportQueue') as any;
const billingEnforcement = jest.requireMock('../../utils/billing/enforcement') as any;

const authenticateRequest = authUtils.authenticateRequest;

const getAuthenticatedUserContext = authenticatedUser.getAuthenticatedUserContext;

const createQueuedExportJob = exportJobs.createQueuedExportJob;

const enqueueExportJobMessage = exportQueue.enqueueExportJobMessage;

const { lambdaHandler } = require('../../controllers/reports/enqueueReportExport');

describe('enqueueReportExport', () => {
	const workspaceId = new ObjectId();
	const userId = new ObjectId();
	const jobId = new ObjectId();

	beforeEach(() => {
		jest.clearAllMocks();

		authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: { sub: 'user-sub' },
			token: 'token',
		});

		getAuthenticatedUserContext.mockResolvedValue({
			userId,
			workspaceId,
		});

		createQueuedExportJob.mockResolvedValue({
			_id: jobId,
			status: 'queued',
			createdAt: new Date('2026-03-08T10:00:00.000Z'),
		});

		enqueueExportJobMessage.mockResolvedValue(undefined);
	});

	it('queues a report export job with persisted filters', async () => {
		const response = await lambdaHandler({
			body: JSON.stringify({
				workspaceId: workspaceId.toString(),
				format: 'pdf',
				conditions: [],
				sort: { field: 'product_name', order: 'asc' },
			}),
			headers: { Authorization: 'Bearer token' },
		} as any);

		expect(response.statusCode).toBe(202);
		expect(JSON.parse(response.body)).toEqual({
			message: 'Report export queued successfully',
			result: {
				jobId: jobId.toString(),
				status: 'queued',
			},
		});

		expect(createQueuedExportJob).toHaveBeenCalledWith({
			target: 'report',
			workspaceId,
			requestedBySub: 'user-sub',
			requestedByUserId: userId,
			format: 'pdf',
			reportParams: {
				conditions: [],
				sort: { field: 'product_name', order: 'asc' },
			},
		});

		expect(billingEnforcement.assertUsageActionAllowed).toHaveBeenCalledWith(
			workspaceId,
			'export',
			1,
		);

		expect(enqueueExportJobMessage).toHaveBeenCalledWith({
			schemaVersion: 1,
			jobId: jobId.toString(),
			target: 'report',
			workspaceId: workspaceId.toString(),
			requestedBySub: 'user-sub',
			requestedByUserId: userId.toString(),
			format: 'pdf',
			queuedAt: '2026-03-08T10:00:00.000Z',
		});
	});

	it('rejects exports for a different workspace', async () => {
		const response = await lambdaHandler({
			body: JSON.stringify({
				workspaceId: new ObjectId().toString(),
				format: 'excel',
				conditions: [],
			}),
			headers: { Authorization: 'Bearer token' },
		} as any);

		expect(response.statusCode).toBe(403);
		expect(JSON.parse(response.body)).toEqual({
			message: 'You are not authorized to export reports for this workspace',
		});
		expect(createQueuedExportJob).not.toHaveBeenCalled();
		expect(enqueueExportJobMessage).not.toHaveBeenCalled();
	});
});
