import { ObjectId } from 'mongodb';
import type { PersistedReportExportRequest } from '../types/reports';
import type { AuditLogExportFilters } from './auditLogV2';

export const EXPORT_JOB_COLLECTION = 'exportJobs';

export const EXPORT_JOB_FORMATS = ['pdf', 'excel', 'csv'] as const;
export type ExportJobFormat = typeof EXPORT_JOB_FORMATS[number];

export const EXPORT_JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
export type ExportJobStatus = typeof EXPORT_JOB_STATUSES[number];

export const EXPORT_JOB_TARGETS = [
	'product',
	'product_specifications',
	'operational_parameters',
	'report',
	'audit_log',
] as const;
export type ExportJobTarget = typeof EXPORT_JOB_TARGETS[number];

export type ExportJob = {
	_id?: ObjectId;
	target: ExportJobTarget;
	targetId?: ObjectId;
	workspaceId: ObjectId;
	requestedBySub: string;
	requestedByUserId?: ObjectId;
	format: ExportJobFormat;
	reportParams?: PersistedReportExportRequest;
	auditLogFilters?: AuditLogExportFilters;
	status: ExportJobStatus;
	attempts: number;
	fileName?: string;
	contentType?: string;
	s3Key?: string;
	errorMessage?: string;
	createdAt: Date;
	updatedAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	failedAt?: Date;
	expiresAt: Date;
};

export type ExportJobDocument = ExportJob & { _id: ObjectId };
