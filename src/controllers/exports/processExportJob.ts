import { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { EXPORT_JOB_FORMATS, EXPORT_JOB_TARGETS, type ExportJobFormat, type ExportJobTarget } from '../../models/exportJob';
import type { AuditLogExportFilters } from '../../models/auditLogV2';
import type { Product } from '../../models/product';
import type { ExportQueueMessage } from '../../types/export-job';
import { EXPORT_LIMITS, type PersistedReportExportRequest } from '../../types/reports';
import { buildAuditLogCsv, loadAuditLogExportRows } from '../../utils/auditLogExport';
import { getDb } from '../../utils/db';
import { generateProductExcelExport, generateWorkbookTabExcelExport, type WorkbookTabTarget } from '../../utils/exportExcel';
import { getExportWorkspaceName } from '../../utils/exportFormatting';
import { generateProductPDFExport, generateWorkbookTabPDFExport } from '../../utils/exportPDF';
import {
	markExportJobCompleted,
	markExportJobFailed,
	markExportJobProcessing,
	recordUsageForCompletedExportJob,
} from '../../utils/exportJobs';
import { logError, logInfo, logWarn } from '../../utils/logger';
import { isProductExportTarget, type ProductExportTarget } from '../../utils/productExportJobs';
import { emitMonitoringMetric } from '../../utils/metrics';
import { generateReportsExcelExport } from '../../utils/reports/exportReportsExcel';
import { generateReportsPDFExport } from '../../utils/reports/exportReportsPDF';
import { buildExportPipeline } from '../../utils/reports/queryBuilder';
import { uploadExportObjectByKey } from '../../utils/s3-storage';
import { withTelemetry } from '../../utils/telemetry';

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

const NON_RETRYABLE_AWS_ERROR_NAMES = new Set([
	'NoSuchBucket',
	'AccessDenied',
	'InvalidAccessKeyId',
	'SignatureDoesNotMatch',
]);

type ExportArtifact = {
	buffer: Buffer;
	fileName: string;
	contentType: string;
};

type ProcessableExportQueueMessage = Pick<ExportQueueMessage, 'jobId' | 'targetId' | 'target' | 'format'>;

type ReportExportProduct = {
	_id: ObjectId;
	product_name: string;
	product_plan_number: string;
	product_description?: string;
	status: string;
	target_date?: Date | null;
	version: number;
	department_id?: ObjectId;
	project_id?: ObjectId;
	product_information?: {
		data?: {
			market_geography?: string;
			country_of_origin?: string;
			oem_contract_manufacturer?: string;
			commercial_clinical?: string;
			manufacturing_location?: string;
			class_of_device?: string;
			basic_udi_di?: string;
		};
		tab_completed?: boolean;
	};
	compliance_information?: {
		tab_completed?: boolean;
	};
	symbols_graphics?: {
		tab_completed?: boolean;
	};
	label_components?: {
		tab_completed?: boolean;
	};
	label_tags?: {
		tab_completed?: boolean;
	};
};

const getReceiveCount = (record: SQSRecord): number => {
	const parsed = Number.parseInt(record.attributes?.ApproximateReceiveCount ?? '1', 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 1;
	return parsed;
};

const toFailureMessage = (error: unknown): string => {
	if (error instanceof Error && error.message) return error.message;
	return 'Export job failed';
};

const isNonRetryableError = (error: unknown): boolean => {
	if (error instanceof NonRetryableExportJobError) return true;

	if (!error || typeof error !== 'object') return false;

	const errorName = (error as { name?: unknown }).name;
	if (typeof errorName !== 'string') return false;

	return NON_RETRYABLE_AWS_ERROR_NAMES.has(errorName);
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
		typeof target !== 'string' ||
		!EXPORT_JOB_TARGETS.includes(target as ExportJobTarget) ||
		typeof format !== 'string' ||
		!EXPORT_JOB_FORMATS.includes(format as ExportJobFormat)
	) {
		throw new NonRetryableExportJobError('Invalid export queue message payload');
	}

	if (target === 'product' && (typeof targetId !== 'string' || !ObjectId.isValid(targetId))) {
		throw new NonRetryableExportJobError('Invalid export queue message payload');
	}

	return {
		jobId,
		targetId,
		target,
		format,
	};
};

const WORKBOOK_TAB_FILE_SUFFIX: Record<WorkbookTabTarget, string> = {
	product_specifications: 'Specifications',
	operational_parameters: 'OperationalParameters',
};

const buildExportFileName = (product: Product, format: 'pdf' | 'excel', target: ProductExportTarget = 'product'): string => {
	const extension = format === 'pdf' ? 'pdf' : 'xlsx';
	const safePlanNumber = (product.product_plan_number || 'product').replace(/[^a-zA-Z0-9._-]/g, '_');
	const suffix = target === 'product' ? '' : `_${WORKBOOK_TAB_FILE_SUFFIX[target]}`;
	return `Product_${safePlanNumber}_v${product.version}${suffix}.${extension}`;
};

const buildReportExportFileName = (format: 'pdf' | 'excel', date: Date = new Date()): string => {
	const extension = format === 'pdf' ? 'pdf' : 'xlsx';
	const timestamp = date.toISOString().split('T')[0];
	return `Products_Report_${timestamp}.${extension}`;
};

const buildExportContentType = (format: 'pdf' | 'excel'): string => {
	if (format === 'pdf') return 'application/pdf';
	return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
};

const AUDIT_EXPORT_FILE_PREFIX = 'Audit_Log';

const buildAuditLogExportFileName = (date: Date = new Date()): string =>
	`${AUDIT_EXPORT_FILE_PREFIX}_${date.toISOString().split('T')[0]}.csv`;

const toDocumentFormat = (format: ExportJobFormat): 'pdf' | 'excel' => {
	if (format === 'csv') throw new NonRetryableExportJobError('CSV is only supported for audit log exports');
	return format;
};

const generateProductArtifact = async ({
	product,
	format,
	target,
}: {
	product: Product;
	format: 'pdf' | 'excel';
	target: ProductExportTarget;
}): Promise<ExportArtifact> => {
	const workspaceName = format === 'pdf' ? await getExportWorkspaceName(product.workspace_id) : '';
	const rawBuffer = target === 'product'
		? await (format === 'pdf' ? generateProductPDFExport(product, workspaceName) : generateProductExcelExport(product))
		: await (format === 'pdf' ? generateWorkbookTabPDFExport(product, target, workspaceName) : generateWorkbookTabExcelExport(product, target));

	if (!rawBuffer) {
		throw new Error('Failed to generate export file');
	}

	const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
	return {
		buffer,
		fileName: buildExportFileName(product, format, target),
		contentType: buildExportContentType(format),
	};
};

const generateReportArtifact = async ({
	reportParams,
	workspaceId,
	format,
}: {
	reportParams: PersistedReportExportRequest;
	workspaceId: ObjectId;
	format: 'pdf' | 'excel';
}): Promise<ExportArtifact> => {
	const db = await getDb();
	const maxLimit = format === 'pdf' ? EXPORT_LIMITS.PDF : EXPORT_LIMITS.EXCEL;
	const pipeline = buildExportPipeline(
		{
			workspaceId: workspaceId.toString(),
			conditions: reportParams.conditions,
			...(reportParams.conditionLogic ? { conditionLogic: reportParams.conditionLogic } : {}),
			...(reportParams.sort ? { sort: reportParams.sort } : {}),
		},
		workspaceId,
		maxLimit,
	);

	const products = (await db.collection<ReportExportProduct>('products').aggregate(pipeline).toArray()) as ReportExportProduct[];
	const context = { workspaceName: await getExportWorkspaceName(workspaceId), conditions: reportParams.conditions, conditionLogic: reportParams.conditionLogic };
	const rawBuffer = format === 'pdf'
		? await generateReportsPDFExport(products, context)
		: await generateReportsExcelExport(products, context);

	if (!rawBuffer) {
		throw new Error('Failed to generate export file');
	}

	const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
	return {
		buffer,
		fileName: buildReportExportFileName(format),
		contentType: buildExportContentType(format),
	};
};

const generateAuditLogArtifact = async ({
	filters,
	workspaceId,
}: {
	filters: AuditLogExportFilters;
	workspaceId: ObjectId;
}): Promise<ExportArtifact> => {
	const { logs, totalCount, truncated } = await loadAuditLogExportRows({ workspaceId, filters });
	if (truncated) {
		logInfo('Audit log export truncated to the row cap', { workspaceId: workspaceId.toString(), totalCount, exported: logs.length });
	}

	return {
		buffer: buildAuditLogCsv(logs),
		fileName: buildAuditLogExportFileName(),
		contentType: 'text/csv; charset=utf-8',
	};
};

/**
 * Processes queued export jobs from SQS.
 * @param {SQSEvent} event - SQS event payload
 * @return {Promise<SQSBatchResponse>} Batch item failure response
 */
export const lambdaHandler = withTelemetry(async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

	for (const record of event.Records) {
		const receiveCount = getReceiveCount(record);
		let parsedMessage: ProcessableExportQueueMessage | null = null;

		try {
			parsedMessage = parseQueueMessage(record);
			const jobId = new ObjectId(parsedMessage.jobId);

			const processingJob = await markExportJobProcessing({
				jobId,
				expectedStatus: ['queued', 'processing'],
				incrementAttempts: true,
			});

			if (!processingJob) {
				await recordUsageForCompletedExportJob(jobId);
				logWarn('Skipping export queue record because job is not claimable', {
					messageId: record.messageId,
					jobId: parsedMessage.jobId,
				});
				continue;
			}

			let artifact: ExportArtifact;
			let s3Key: string;

			if (isProductExportTarget(processingJob.target)) {
				const targetId = processingJob.targetId ?? (parsedMessage.targetId ? new ObjectId(parsedMessage.targetId) : undefined);
				if (!targetId) {
					throw new NonRetryableExportJobError('Product export job is missing target product id');
				}

				const db = await getDb();
				const product = await db.collection<Product>('products').findOne({
					_id: targetId,
					workspace_id: processingJob.workspaceId,
				});

				if (!product) {
					throw new NonRetryableExportJobError('Product not found for export job');
				}

				artifact = await generateProductArtifact({
					product,
					format: toDocumentFormat(parsedMessage.format),
					target: processingJob.target,
				});
				s3Key = `${EXPORTS_PREFIX}/products/${processingJob.workspaceId.toString()}/${jobId.toString()}/${artifact.fileName}`;
			} else if (processingJob.target === 'report') {
				if (!processingJob.reportParams) {
					throw new NonRetryableExportJobError('Report export job is missing report parameters');
				}

				artifact = await generateReportArtifact({
					reportParams: processingJob.reportParams,
					workspaceId: processingJob.workspaceId,
					format: toDocumentFormat(parsedMessage.format),
				});
				s3Key = `${EXPORTS_PREFIX}/reports/${processingJob.workspaceId.toString()}/${jobId.toString()}/${artifact.fileName}`;
			} else if (processingJob.target === 'audit_log') {
				if (!processingJob.auditLogFilters) {
					throw new NonRetryableExportJobError('Audit log export job is missing filters');
				}

				artifact = await generateAuditLogArtifact({
					filters: processingJob.auditLogFilters,
					workspaceId: processingJob.workspaceId,
				});
				s3Key = `${EXPORTS_PREFIX}/audit-logs/${processingJob.workspaceId.toString()}/${jobId.toString()}/${artifact.fileName}`;
			} else {
				throw new NonRetryableExportJobError('Unsupported export job target');
			}

			await uploadExportObjectByKey({
				key: s3Key,
				body: artifact.buffer,
				contentType: artifact.contentType,
			});

			await markExportJobCompleted({
				jobId,
				workspaceId: processingJob.workspaceId,
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
			const isNonRetryable = isNonRetryableError(error);
			const shouldStopRetry = isNonRetryable || receiveCount >= MAX_RECEIVE_COUNT;

			if (shouldStopRetry) {
				emitMonitoringMetric('ExportJobFailed');
			}

			if (parsedMessage?.jobId && shouldStopRetry && ObjectId.isValid(parsedMessage.jobId)) {
				const failedJobId = new ObjectId(parsedMessage.jobId);
				await markExportJobFailed({ jobId: failedJobId, errorMessage: toFailureMessage(error) });
				await recordUsageForCompletedExportJob(failedJobId).catch((billingError) => {
					logError('Failed to bill completed export job', billingError, { jobId: parsedMessage?.jobId });
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
});
