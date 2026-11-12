import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findOne = jest.fn<() => Promise<unknown>>();
const findOneAndUpdate = jest.fn<() => Promise<unknown>>();
const countDocuments = jest.fn<(filter: Record<string, any>) => Promise<number>>();

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(async () => ({
		collection: jest.fn(() => ({
			findOne,
			findOneAndUpdate,
			countDocuments,
			createIndex: jest.fn(),
		})),
	})),
}));

jest.mock('../../utils/billing/usageRecording', () => ({
	recordCompletedExport: jest.fn(),
}));

const usageRecording = jest.requireMock('../../utils/billing/usageRecording') as any;
const {
	countActiveExportJobs,
	getExportJobById,
	getExportJobByIdForUser,
	markExportJobCompleted,
	recordUsageForCompletedExportJob,
} = require('../../utils/exportJobs');

describe('export job lookups', () => {
	const jobId = new ObjectId();
	const workspaceId = new ObjectId();
	const otherWorkspaceId = new ObjectId();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('getExportJobById filters by workspaceId', async () => {
		findOne.mockResolvedValue(null);

		await getExportJobById({ jobId, workspaceId });

		expect(findOne).toHaveBeenCalledWith({ _id: jobId, workspaceId });
	});

	it('getExportJobByIdForUser filters by workspaceId and requestedBySub', async () => {
		findOne.mockResolvedValue(null);

		await getExportJobByIdForUser({
			jobId,
			workspaceId: otherWorkspaceId,
			requestedBySub: 'user-sub',
			target: 'product',
		});

		expect(findOne).toHaveBeenCalledWith({
			_id: jobId,
			workspaceId: otherWorkspaceId,
			requestedBySub: 'user-sub',
			target: 'product',
		});
	});
});

describe('markExportJobCompleted', () => {
	const jobId = new ObjectId();
	const workspaceId = new ObjectId();
	const input = { jobId, workspaceId, s3Key: 'key', fileName: 'a.pdf', contentType: 'application/pdf' };

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('records usage after the job is completed', async () => {
		usageRecording.recordCompletedExport.mockResolvedValue(undefined);
		findOneAndUpdate.mockResolvedValue({ _id: jobId });

		await markExportJobCompleted(input);

		expect(usageRecording.recordCompletedExport).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, jobId }));
		expect(findOneAndUpdate.mock.invocationCallOrder[0])
			.toBeLessThan(usageRecording.recordCompletedExport.mock.invocationCallOrder[0]);
	});

	it('does not bill a job that could not be completed', async () => {
		findOneAndUpdate.mockResolvedValue(null);

		await markExportJobCompleted(input);

		expect(usageRecording.recordCompletedExport).not.toHaveBeenCalled();
	});

	it('does not bill a job that is not completed', async () => {
		findOne.mockResolvedValue(null);

		await recordUsageForCompletedExportJob(jobId);

		expect(usageRecording.recordCompletedExport).not.toHaveBeenCalled();
	});

	it('bills a completed job when a retry finds it already completed', async () => {
		findOne.mockResolvedValue({ _id: jobId, workspaceId, completedAt: new Date() });

		await recordUsageForCompletedExportJob(jobId);

		expect(findOne).toHaveBeenCalledWith({ _id: jobId, status: 'completed' }, expect.anything());
		expect(usageRecording.recordCompletedExport).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, jobId }));
	});
});

describe('countActiveExportJobs', () => {
	it('ignores processing jobs that started more than 2 hours ago', async () => {
		countDocuments.mockResolvedValue(0);

		await countActiveExportJobs({ workspaceId: new ObjectId(), periodStart: new Date(0), periodEnd: new Date() });

		const cutoff = countDocuments.mock.calls[0][0].$or[1].startedAt.$gte as Date;
		expect(Math.abs(Date.now() - cutoff.getTime() - 2 * 60 * 60 * 1000)).toBeLessThan(5000);
	});
});
