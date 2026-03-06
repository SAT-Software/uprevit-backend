import { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import type { Product } from '../../models/product';
import type { ExportQueueMessage } from '../../types/export-job';
import { getDb } from '../../utils/db';
import { generateProductExcelExport } from '../../utils/exportExcel';
import { generateProductPDFExport } from '../../utils/exportPDF';
import { logError, logInfo, logWarn } from '../../utils/logger';
import {
	markProductExportJobCompleted,
	markProductExportJobFailed,
	markProductExportJobProcessing,
} from '../../utils/productExportJobs';
import { uploadExportObjectByKey } from '../../utils/s3-storage';

const EXPORTS_PREFIX = (process.env.EXPORTS_PREFIX || 'exports').replace(/^\/+|\/+$/g, '');
const DEFAULT_MAX_RECEIVE_COUNT = 4;
const parsedMaxReceiveCount = Number.parseInt(process.env.EXPORT_JOB_MAX_RECEIVE_COUNT ?? '', 10);
const MAX_RECEIVE_COUNT = Number.isFinite(parsedMaxReceiveCount)
	&& Number.isInteger(parsedMaxReceiveCount)
	&& parsedMaxReceiveCount > 0
	? parsedMaxReceiveCount
	: DEFAULT_MAX_RECEIVE_COUNT;

/**
 * Error used for queue messages that should not be retried.
 */
class NonRetryableExportJobError extends Error {}

type ExportArtifact = {
	buffer: Buffer;
	fileName: string;
	contentType: string;
};

type ProcessableExportQueueMessage = Pick<ExportQueueMessage, 'jobId' | 'targetId' | 'target' | 'format'>;

const getReceiveCount = (record: SQSRecord): number => {
	const parsed = Number.parseInt(record.attributes?.ApproximateReceiveCount ?? '1', 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 1;
	return parsed;
};

const toFailureMessage = (error: unknown): string => {
	if (error instanceof Error && error.message) return error.message;
	return 'Export job failed';
};

const parseQueueMessage = (record: SQSRecord): ProcessableExportQueueMessage => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(record.body);
	} catch {
		throw new NonRetryableExportJobError('Invalid export queue message payload');
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NonRetryableExportJobError('Invalid export queue message payload');
	}

	const payload = parsed as Partial<ExportQueueMessage>;
	const { jobId, targetId, target, format } = payload;

	if (
		typeof jobId !== 'string' ||
		!ObjectId.isValid(jobId) ||
		typeof targetId !== 'string' ||
		!ObjectId.isValid(targetId) ||
		target !== 'product' ||
		(format !== 'pdf' && format !== 'excel')
	) {
		throw new NonRetryableExportJobError('Invalid export queue message payload');
	}

	return {
		jobId,
		targetId,
		target,
		format,
	};
};

const buildExportFileName = (product: Product, format: 'pdf' | 'excel'): string => {
	const extension = format === 'pdf' ? 'pdf' : 'xlsx';
	const safePlanNumber = (product.product_plan_number || 'product').replace(/[^a-zA-Z0-9._-]/g, '_');
	return `Product_${safePlanNumber}_v${product.version}.${extension}`;
};

const buildExportContentType = (format: 'pdf' | 'excel'): string => {
	if (format === 'pdf') return 'application/pdf';
	return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
};

const generateProductArtifact = async ({
	product,
	format,
}: {
	product: Product;
	format: 'pdf' | 'excel';
}): Promise<ExportArtifact> => {
	const rawBuffer = format === 'pdf'
		? await generateProductPDFExport(product)
		: await generateProductExcelExport(product);

	if (!rawBuffer) {
		throw new Error('Failed to generate export file');
	}

	const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
	return {
		buffer,
		fileName: buildExportFileName(product, format),
		contentType: buildExportContentType(format),
	};
};

/**
 * Processes queued export jobs from SQS.
 * @param {SQSEvent} event - SQS event payload
 * @return {Promise<SQSBatchResponse>} Batch item failure response
 */
export const lambdaHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

	for (const record of event.Records) {
		const receiveCount = getReceiveCount(record);
		let parsedMessage: ProcessableExportQueueMessage | null = null;

		try {
			parsedMessage = parseQueueMessage(record);
			const jobId = new ObjectId(parsedMessage.jobId);
			const targetId = new ObjectId(parsedMessage.targetId);

			const processingJob = await markProductExportJobProcessing({
				jobId,
				expectedStatus: ['queued', 'processing'],
				incrementAttempts: true,
			});

			if (!processingJob) {
				logWarn('Skipping export queue record because job is not claimable', {
					messageId: record.messageId,
					jobId: parsedMessage.jobId,
				});
				continue;
			}

			const db = await getDb();
			const product = await db.collection<Product>('products').findOne({
				_id: targetId,
				workspace_id: processingJob.workspaceId,
			});

			if (!product) {
				await markProductExportJobFailed({
					jobId,
					errorMessage: 'Product not found for export job',
				});
				continue;
			}

			const artifact = await generateProductArtifact({
				product,
				format: parsedMessage.format,
			});

			const s3Key = `${EXPORTS_PREFIX}/products/${processingJob.workspaceId.toString()}/${jobId.toString()}/${artifact.fileName}`;

			await uploadExportObjectByKey({
				key: s3Key,
				body: artifact.buffer,
				contentType: artifact.contentType,
			});

			await markProductExportJobCompleted({
				jobId,
				s3Key,
				fileName: artifact.fileName,
				contentType: artifact.contentType,
			});

			logInfo('Export job processed successfully', {
				messageId: record.messageId,
				jobId: parsedMessage.jobId,
				format: parsedMessage.format,
				target: parsedMessage.target,
				receiveCount,
			});
		} catch (error) {
			const isNonRetryable = error instanceof NonRetryableExportJobError;
			const shouldStopRetry = isNonRetryable || receiveCount >= MAX_RECEIVE_COUNT;

			if (parsedMessage?.jobId && shouldStopRetry && ObjectId.isValid(parsedMessage.jobId)) {
				await markProductExportJobFailed({
					jobId: new ObjectId(parsedMessage.jobId),
					errorMessage: toFailureMessage(error),
				});
			}

			logError('Failed to process export queue record', error, {
				messageId: record.messageId,
				jobId: parsedMessage?.jobId,
				receiveCount,
				isNonRetryable,
				shouldStopRetry,
			});

			if (!shouldStopRetry) {
				batchItemFailures.push({ itemIdentifier: record.messageId });
			}
		}
	}

	return { batchItemFailures };
};
