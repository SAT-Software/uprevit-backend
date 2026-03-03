import { ObjectId } from 'mongodb';

export const EXPORT_JOB_COLLECTION = 'exportJobs';

export const EXPORT_JOB_FORMATS = ['pdf', 'excel'] as const;
export type ExportJobFormat = typeof EXPORT_JOB_FORMATS[number];

export const EXPORT_JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
export type ExportJobStatus = typeof EXPORT_JOB_STATUSES[number];

export const EXPORT_JOB_TARGETS = [
	'product',
	'product_specifications',
	'operational_parameters',
	'report',
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
