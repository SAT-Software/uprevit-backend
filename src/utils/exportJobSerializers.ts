import type { ExportJobDocument } from '../models/exportJob';
import type { ExportJobSummary } from '../types/export-job';

/**
 * Converts an export job document to API-safe response shape.
 * @param {ExportJobDocument} job - Export job document
 * @return {ExportJobSummary} Serialized export job summary
 */
export const toExportJobSummary = (job: ExportJobDocument): ExportJobSummary => {
	return {
		jobId: job._id.toString(),
		target: job.target,
		targetId: job.targetId?.toString(),
		workspaceId: job.workspaceId.toString(),
		format: job.format,
		status: job.status,
		attempts: job.attempts,
		fileName: job.fileName,
		contentType: job.contentType,
		errorMessage: job.errorMessage,
		createdAt: job.createdAt.toISOString(),
		updatedAt: job.updatedAt.toISOString(),
		startedAt: job.startedAt?.toISOString(),
		completedAt: job.completedAt?.toISOString(),
		failedAt: job.failedAt?.toISOString(),
		expiresAt: job.expiresAt.toISOString(),
	};
};
