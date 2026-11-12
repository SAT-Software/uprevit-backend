import { ObjectId } from 'mongodb';
import type { ExportJobDocument, ExportJobFormat, ExportJobStatus, ExportJobTarget } from '../models/exportJob';
import {
	buildExportExpiryDate,
	createQueuedExportJob,
	ensureExportJobIndexes,
	getExportJobByIdForUser,
	isExportStatus,
	listExportJobsForUser,
	markExportJobCompleted,
	markExportJobFailed,
	markExportJobProcessing,
} from './exportJobs';

export const buildProductExportExpiryDate = buildExportExpiryDate;

export const ensureProductExportJobIndexes = ensureExportJobIndexes;

export const isProductExportStatus = isExportStatus;

export type ProductExportTarget = 'product' | 'product_specifications' | 'operational_parameters';

export const PRODUCT_EXPORT_TARGETS: ProductExportTarget[] = ['product', 'product_specifications', 'operational_parameters'];

export const isProductExportTarget = (value: unknown): value is ProductExportTarget =>
	PRODUCT_EXPORT_TARGETS.some((target) => target === value);

export const createQueuedProductExportJob = async ({
	productId,
	target = 'product',
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
	target?: ProductExportTarget;
}): Promise<ExportJobDocument> => {
	return createQueuedExportJob({
		target,
		targetId: productId,
		workspaceId,
		requestedBySub,
		requestedByUserId,
		format,
		expiresAt,
	});
};

export const markProductExportJobProcessing = markExportJobProcessing;

export const markProductExportJobCompleted = markExportJobCompleted;

export const markProductExportJobFailed = markExportJobFailed;

export const getProductExportJobByIdForUser = async ({
	jobId,
	workspaceId,
	requestedBySub,
	target,
}: {
	jobId: ObjectId;
	workspaceId: ObjectId;
	requestedBySub: string;
	target?: ExportJobTarget | ExportJobTarget[];
}): Promise<ExportJobDocument | null> => {
	return getExportJobByIdForUser({
		jobId,
		workspaceId,
		requestedBySub,
		target,
	});
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
	target?: ExportJobTarget | ExportJobTarget[];
	targetId?: ObjectId;
	statuses?: ExportJobStatus[];
	page?: number;
	limit?: number;
}) => {
	return listExportJobsForUser({
		requestedBySub,
		workspaceId,
		target,
		targetId,
		statuses,
		page,
		limit,
	});
};
