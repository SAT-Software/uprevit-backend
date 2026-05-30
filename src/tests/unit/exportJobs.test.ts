import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findOne = jest.fn<() => Promise<unknown>>();

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(async () => ({
		collection: jest.fn(() => ({
			findOne,
			createIndex: jest.fn(),
		})),
	})),
}));

const { getExportJobById, getExportJobByIdForUser } = require('../../utils/exportJobs');

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
