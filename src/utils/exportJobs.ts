import { ObjectId } from 'mongodb';
import {
	EXPORT_JOB_COLLECTION,
	type ExportJob,
	type ExportJobDocument,
	type ExportJobFormat,
	EXPORT_JOB_STATUSES,
	type ExportJobStatus,
	type ExportJobTarget,
} from '../models/exportJob';
import type { PersistedReportExportRequest } from '../types/reports';
import { getDb } from './db';
import { recordCompletedExport } from './billing/usageRecording';

const DEFAULT_EXPORT_FILE_TTL_HOURS = 24;
const EXPORT_JOBS_PAGE_LIMIT = 10;
const TERMINAL_EXPORT_JOB_STATUSES: ExportJobStatus[] = ['completed', 'failed'];
const ACTIVE_EXPORT_JOB_STATUSES: ExportJobStatus[] = ['queued', 'processing'];

let hasEnsuredExportJobIndexes = false;

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value ?? '', 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const EXPORT_FILE_TTL_HOURS = parsePositiveInteger(process.env.PRODUCT_EXPORT_FILE_TTL_HOURS, DEFAULT_EXPORT_FILE_TTL_HOURS);

const toStatusArray = (
	status?: ExportJobStatus | ExportJobStatus[],
): ExportJobStatus[] => {
	if (!status) return ['queued'];
	if (Array.isArray(status)) return status;
	return [status];
};

const normalizePagination = ({
	page,
	limit,
}: {
	page?: number;
	limit?: number;
}) => {
	const normalizedPage = typeof page === 'number' && Number.isFinite(page) && page > 0
		? Math.floor(page)
		: 1;
	const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
		? Math.min(EXPORT_JOBS_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
		: EXPORT_JOBS_PAGE_LIMIT;

	return {
		page: normalizedPage,
		limit: normalizedLimit,
		skip: (normalizedPage - 1) * normalizedLimit,
	};
};

export const buildExportExpiryDate = (baseDate: Date = new Date()): Date => {
	return new Date(baseDate.getTime() + EXPORT_FILE_TTL_HOURS * 60 * 60 * 1000);
};

const getCollection = async () => {
	const db = await getDb();
	return db.collection<ExportJob>(EXPORT_JOB_COLLECTION);
};

export const ensureExportJobIndexes = async () => {
	if (hasEnsuredExportJobIndexes) return;

	const collection = await getCollection();

	await Promise.all([
		collection.createIndex({ requestedBySub: 1, createdAt: -1 }),
		collection.createIndex({ workspaceId: 1, createdAt: -1 }),
		collection.createIndex({ target: 1, targetId: 1, createdAt: -1 }),
		collection.createIndex({ status: 1, createdAt: -1 }),
		collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
	]);

	hasEnsuredExportJobIndexes = true;
};

export const isExportStatus = (value: unknown): value is ExportJobStatus => {
	return typeof value === 'string' && EXPORT_JOB_STATUSES.includes(value as ExportJobStatus);
};

export const createQueuedExportJob = async ({
	target,
	targetId,
	workspaceId,
	requestedBySub,
	requestedByUserId,
	format,
	reportParams,
	expiresAt,
}: {
	target: ExportJobTarget;
	targetId?: ObjectId;
	workspaceId: ObjectId;
	requestedBySub: string;
	requestedByUserId?: ObjectId;
	format: ExportJobFormat;
	reportParams?: PersistedReportExportRequest;
	expiresAt?: Date;
}): Promise<ExportJobDocument> => {
	await ensureExportJobIndexes();

	const collection = await getCollection();
	const now = new Date();
	const payload: ExportJob = {
		target,
		workspaceId,
		requestedBySub,
		requestedByUserId,
		format,
		status: 'queued',
		attempts: 0,
		createdAt: now,
		updatedAt: now,
		expiresAt: expiresAt ?? buildExportExpiryDate(now),
		...(targetId ? { targetId } : {}),
		...(reportParams ? { reportParams } : {}),
	};

	const insertResult = await collection.insertOne(payload);

	return {
		...payload,
		_id: insertResult.insertedId,
	};
};

export const markExportJobProcessing = async ({
	jobId,
	expectedStatus,
	incrementAttempts = true,
	startedAt,
}: {
	jobId: ObjectId;
	expectedStatus?: ExportJobStatus | ExportJobStatus[];
	incrementAttempts?: boolean;
	startedAt?: Date;
}): Promise<ExportJobDocument | null> => {
	const collection = await getCollection();
	const now = startedAt ?? new Date();
	const expectedStatuses = toStatusArray(expectedStatus);

	const update: {
		$set: Partial<ExportJob>;
		$unset: Record<string, ''>;
		$inc?: { attempts: number };
	} = {
		$set: {
			status: 'processing',
			startedAt: now,
			updatedAt: now,
		},
		$unset: {
			completedAt: '',
			failedAt: '',
			errorMessage: '',
			fileName: '',
			contentType: '',
			s3Key: '',
		},
	};

	if (incrementAttempts) {
		update.$inc = { attempts: 1 };
	}

	return collection.findOneAndUpdate(
		{
			_id: jobId,
			status: { $in: expectedStatuses },
		},
		update,
		{ returnDocument: 'after' },
	);
};

export const markExportJobCompleted = async ({
	jobId,
	s3Key,
	fileName,
	contentType,
	completedAt,
}: {
	jobId: ObjectId;
	s3Key: string;
	fileName: string;
	contentType: string;
	completedAt?: Date;
}): Promise<ExportJobDocument | null> => {
	const collection = await getCollection();
	const now = completedAt ?? new Date();

	const completedJob = await collection.findOneAndUpdate(
		{
			_id: jobId,
			status: { $nin: TERMINAL_EXPORT_JOB_STATUSES },
		},
		{
			$set: {
				status: 'completed',
				s3Key,
				fileName,
				contentType,
				completedAt: now,
				updatedAt: now,
			},
			$unset: {
				failedAt: '',
				errorMessage: '',
			},
		},
		{ returnDocument: 'after' },
	);

	if (completedJob?.workspaceId) {
		await recordCompletedExport({
			workspaceId: completedJob.workspaceId,
			jobId,
			occurredAt: now,
		});
	}

	return completedJob;
};

export const markExportJobFailed = async ({
	jobId,
	errorMessage,
	failedAt,
}: {
	jobId: ObjectId;
	errorMessage: string;
	failedAt?: Date;
}): Promise<ExportJobDocument | null> => {
	const collection = await getCollection();
	const now = failedAt ?? new Date();

	return collection.findOneAndUpdate(
		{
			_id: jobId,
			status: { $nin: TERMINAL_EXPORT_JOB_STATUSES },
		},
		{
			$set: {
				status: 'failed',
				errorMessage,
				failedAt: now,
				updatedAt: now,
			},
			$unset: {
				completedAt: '',
			},
		},
		{ returnDocument: 'after' },
	);
};

export const getExportJobById = async ({
	jobId,
	workspaceId,
}: {
	jobId: ObjectId;
	workspaceId: ObjectId;
}): Promise<ExportJobDocument | null> => {
	const collection = await getCollection();
	return collection.findOne({ _id: jobId, workspaceId });
};

export const getExportJobByIdForUser = async ({
	jobId,
	workspaceId,
	requestedBySub,
	target,
}: {
	jobId: ObjectId;
	workspaceId: ObjectId;
	requestedBySub: string;
	target?: ExportJobTarget;
}): Promise<ExportJobDocument | null> => {
	const collection = await getCollection();

	const query: {
		_id: ObjectId;
		workspaceId: ObjectId;
		requestedBySub: string;
		target?: ExportJobTarget;
	} = {
		_id: jobId,
		workspaceId,
		requestedBySub,
	};

	if (target) {
		query.target = target;
	}

	return collection.findOne(query);
};

export const listExportJobsForUser = async ({
	requestedBySub,
	workspaceId,
	target,
	targetId,
	statuses,
	page,
	limit,
}: {
	requestedBySub: string;
	workspaceId?: ObjectId;
	target?: ExportJobTarget;
	targetId?: ObjectId;
	statuses?: ExportJobStatus[];
	page?: number;
	limit?: number;
}): Promise<{
	jobs: ExportJobDocument[];
	hasActiveJobs: boolean;
	activeJobsCount: number;
	pagination: {
		page: number;
		limit: number;
		totalCount: number;
		totalPages: number;
		hasNextPage: boolean;
		hasPrevPage: boolean;
	};
}> => {
	const collection = await getCollection();
	const { page: normalizedPage, limit: normalizedLimit, skip } = normalizePagination({ page, limit });

	const query: {
		requestedBySub: string;
		workspaceId?: ObjectId;
		target?: ExportJobTarget;
		targetId?: ObjectId;
		status?: { $in: ExportJobStatus[] };
	} = {
		requestedBySub,
	};

	if (workspaceId) {
		query.workspaceId = workspaceId;
	}

	if (target) {
		query.target = target;
	}

	if (targetId) {
		query.targetId = targetId;
	}

	if (statuses?.length) {
		query.status = { $in: statuses };
	}

	const activeJobsQuery: {
		requestedBySub: string;
		workspaceId?: ObjectId;
		target?: ExportJobTarget;
		targetId?: ObjectId;
		status: { $in: ExportJobStatus[] };
	} = {
		requestedBySub,
		status: { $in: ACTIVE_EXPORT_JOB_STATUSES },
	};

	if (workspaceId) {
		activeJobsQuery.workspaceId = workspaceId;
	}

	if (target) {
		activeJobsQuery.target = target;
	}

	if (targetId) {
		activeJobsQuery.targetId = targetId;
	}

	const [jobs, totalCount, activeJobsCount] = await Promise.all([
		collection
			.find(query)
			.sort({ createdAt: -1, _id: -1 })
			.skip(skip)
			.limit(normalizedLimit)
			.toArray(),
		collection.countDocuments(query),
		collection.countDocuments(activeJobsQuery),
	]);

	const totalPages = Math.max(1, Math.ceil(totalCount / normalizedLimit));

	return {
		jobs,
		hasActiveJobs: activeJobsCount > 0,
		activeJobsCount,
		pagination: {
			page: normalizedPage,
			limit: normalizedLimit,
			totalCount,
			totalPages,
			hasNextPage: normalizedPage * normalizedLimit < totalCount,
			hasPrevPage: normalizedPage > 1,
		},
	};
};
