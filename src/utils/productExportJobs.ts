import { ObjectId } from 'mongodb';
import type { ExportJobDocument, ExportJobFormat } from '../models/exportJob';
import { createQueuedExportJob } from './exportJobs';

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
