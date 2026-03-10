import type { ExportJobFormat, ExportJobStatus, ExportJobTarget } from '../models/exportJob';

export type ExportQueueMessage = {
	schemaVersion: 1;
	jobId: string;
	target: ExportJobTarget;
	targetId?: string;
	workspaceId: string;
	requestedBySub: string;
	requestedByUserId?: string;
	format: ExportJobFormat;
	queuedAt: string;
};

export type ExportEnqueueResponse = {
	message: string;
	result: {
		jobId: string;
		status: ExportJobStatus;
	};
};

export type ExportJobSummary = {
	jobId: string;
	target: ExportJobTarget;
	targetId?: string;
	workspaceId: string;
	format: ExportJobFormat;
	status: ExportJobStatus;
	attempts: number;
	fileName?: string;
	contentType?: string;
	errorMessage?: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	expiresAt: string;
};

export type ExportJobDetailResponse = {
	message: string;
	result: ExportJobSummary;
};

export type ExportJobsListResponse = {
	message: string;
	result: {
		jobs: ExportJobSummary[];
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
	};
};

export type ExportDownloadResponse = {
	message: string;
	result: {
		jobId: string;
		downloadUrl: string;
		fileName?: string;
		contentType?: string;
		expiresAt: string;
	};
};
