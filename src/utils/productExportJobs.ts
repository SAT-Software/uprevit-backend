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
import { getDb } from './db';

const DEFAULT_EXPORT_FILE_TTL_HOURS = 24;
const EXPORT_JOBS_PAGE_LIMIT = 10;
const TERMINAL_EXPORT_JOB_STATUSES: ExportJobStatus[] = ['completed', 'failed'];
const ACTIVE_EXPORT_JOB_STATUSES: ExportJobStatus[] = ['queued', 'processing'];

let hasEnsuredProductExportJobIndexes = false;

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

export const buildProductExportExpiryDate = (baseDate: Date = new Date()): Date => {
	return new Date(baseDate.getTime() + EXPORT_FILE_TTL_HOURS * 60 * 60 * 1000);
};

const getCollection = async () => {
	const db = await getDb();
	return db.collection<ExportJob>(EXPORT_JOB_COLLECTION);
};

export const ensureProductExportJobIndexes = async () => {
	if (hasEnsuredProductExportJobIndexes) return;

	const collection = await getCollection();

	await Promise.all([
		collection.createIndex({ requestedBySub: 1, createdAt: -1 }),
		collection.createIndex({ workspaceId: 1, createdAt: -1 }),
		collection.createIndex({ target: 1, targetId: 1, createdAt: -1 }),
		collection.createIndex({ status: 1, createdAt: -1 }),
		collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
	]);

	hasEnsuredProductExportJobIndexes = true;
};

export const isProductExportStatus = (value: unknown): value is ExportJobStatus => {
	return typeof value === 'string' && EXPORT_JOB_STATUSES.includes(value as ExportJobStatus);
};

export const createQueuedProductExportJob = async ({
	productId,
	workspaceId,
	requestedBySub,
	requestedByUserId,
	format,
	expiresAt,
}: {
	productId: ObjectId;
	workspaceId: ObjectId;
	requestedBySub: string;
	requestedByUserId?: ObjectId;
	format: ExportJobFormat;
	expiresAt?: Date;
}): Promise<ExportJobDocument> => {
	await ensureProductExportJobIndexes();

	const collection = await getCollection();
	const now = new Date();
	const payload: ExportJob = {
		target: 'product',
		targetId: productId,
		workspaceId,
		requestedBySub,
		requestedByUserId,
		format,
		status: 'queued',
		attempts: 0,
		createdAt: now,
		updatedAt: now,
		expiresAt: expiresAt ?? buildProductExportExpiryDate(now),
	};

	const insertResult = await collection.insertOne(payload);

	return {
		...payload,
		_id: insertResult.insertedId,
	};
};

export const markProductExportJobProcessing = async ({
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

export const markProductExportJobCompleted = async ({
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

	return collection.findOneAndUpdate(
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
};

export const markProductExportJobFailed = async ({
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

export const getProductExportJobByIdForUser = async ({
	jobId,
	requestedBySub,
	target,
}: {
	jobId: ObjectId;
	requestedBySub: string;
	target?: ExportJobTarget;
}): Promise<ExportJobDocument | null> => {
	const collection = await getCollection();

	const query: {
		_id: ObjectId;
		requestedBySub: string;
		target?: ExportJobTarget;
	} = {
		_id: jobId,
		requestedBySub,
	};

	if (target) {
		query.target = target;
	}

	return collection.findOne(query);
};

export const listProductExportJobsForUser = async ({
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
