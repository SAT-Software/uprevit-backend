import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/exportJobs', () => ({
	markExportJobCompleted: jest.fn(),
	markExportJobFailed: jest.fn(),
	markExportJobProcessing: jest.fn(),
}));

jest.mock('../../utils/db', () => ({
	getDb: jest.fn(),
}));

jest.mock('../../utils/exportPDF', () => ({
	generateProductPDFExport: jest.fn(),
}));

jest.mock('../../utils/exportExcel', () => ({
	generateProductExcelExport: jest.fn(),
}));

jest.mock('../../utils/reports/exportReportsPDF', () => ({
	generateReportsPDFExport: jest.fn(),
}));

jest.mock('../../utils/reports/exportReportsExcel', () => ({
	generateReportsExcelExport: jest.fn(),
}));

jest.mock('../../utils/reports/queryBuilder', () => ({
	buildExportPipeline: jest.fn(),
}));

jest.mock('../../utils/s3-storage', () => ({
	uploadExportObjectByKey: jest.fn(),
}));

const exportJobs = jest.requireMock('../../utils/exportJobs') as any;
const dbUtils = jest.requireMock('../../utils/db') as any;
const exportPdfUtils = jest.requireMock('../../utils/exportPDF') as any;
const reportPdfUtils = jest.requireMock('../../utils/reports/exportReportsPDF') as any;
const queryBuilderUtils = jest.requireMock('../../utils/reports/queryBuilder') as any;
const s3StorageUtils = jest.requireMock('../../utils/s3-storage') as any;

const markExportJobCompleted = exportJobs.markExportJobCompleted;
const markExportJobFailed = exportJobs.markExportJobFailed;
const markExportJobProcessing = exportJobs.markExportJobProcessing;

const getDb = dbUtils.getDb;

const generateProductPDFExport = exportPdfUtils.generateProductPDFExport;

const generateReportsPDFExport = reportPdfUtils.generateReportsPDFExport;

const buildExportPipeline = queryBuilderUtils.buildExportPipeline;

const uploadExportObjectByKey = s3StorageUtils.uploadExportObjectByKey;

const { lambdaHandler } = require('../../controllers/exports/processExportJob');

describe('processExportJob', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		markExportJobCompleted.mockResolvedValue(null);
		markExportJobFailed.mockResolvedValue(null);
		uploadExportObjectByKey.mockResolvedValue(undefined);
	});

	it('processes product export jobs without regression', async () => {
		const jobId = new ObjectId();
		const workspaceId = new ObjectId();
		const productId = new ObjectId();

		markExportJobProcessing.mockResolvedValue({
			_id: jobId,
			target: 'product',
			targetId: productId,
			workspaceId,
		});

		const findOne = jest.fn() as any;
		findOne.mockResolvedValue({
			_id: productId,
			workspace_id: workspaceId,
			product_plan_number: 'ABC/123',
			version: 2,
		});

		getDb.mockResolvedValue({
			collection: jest.fn().mockReturnValue({
				findOne,
			}),
		});

		generateProductPDFExport.mockResolvedValue(Buffer.from('product-pdf'));

		const result = await lambdaHandler({
			Records: [{
				messageId: 'msg-1',
				body: JSON.stringify({
					schemaVersion: 1,
					jobId: jobId.toString(),
					target: 'product',
					targetId: productId.toString(),
					workspaceId: workspaceId.toString(),
					requestedBySub: 'user-sub',
					format: 'pdf',
					queuedAt: '2026-03-08T10:00:00.000Z',
				}),
				attributes: { ApproximateReceiveCount: '1' },
			}],
		} as any);

		expect(result).toEqual({ batchItemFailures: [] });
		expect(uploadExportObjectByKey).toHaveBeenCalledWith({
			key: expect.stringContaining(`/products/${workspaceId.toString()}/${jobId.toString()}/Product_ABC_123_v2.pdf`),
			body: Buffer.from('product-pdf'),
			contentType: 'application/pdf',
		});
		expect(markExportJobCompleted).toHaveBeenCalledWith({
			jobId,
			s3Key: expect.stringContaining(`/products/${workspaceId.toString()}/${jobId.toString()}/Product_ABC_123_v2.pdf`),
			fileName: 'Product_ABC_123_v2.pdf',
			contentType: 'application/pdf',
		});
		expect(markExportJobFailed).not.toHaveBeenCalled();
	});

	it('processes report export jobs asynchronously', async () => {
		const jobId = new ObjectId();
		const workspaceId = new ObjectId();
		const products = [{
			_id: new ObjectId(),
			product_name: 'Test Product',
			product_plan_number: 'PLAN-1',
			status: 'draft',
			version: 1,
		}];

		markExportJobProcessing.mockResolvedValue({
			_id: jobId,
			target: 'report',
			workspaceId,
			reportParams: {
				conditions: [],
				sort: { field: 'product_name', order: 'asc' },
			},
		});

		buildExportPipeline.mockReturnValue([{ $match: { workspace_id: workspaceId } }]);
		const toArray = jest.fn() as any;
		toArray.mockResolvedValue(products);
		getDb.mockResolvedValue({
			collection: jest.fn().mockReturnValue({
				aggregate: jest.fn().mockReturnValue({
					toArray,
				}),
			}),
		});

		generateReportsPDFExport.mockResolvedValue(Buffer.from('report-pdf'));

		const result = await lambdaHandler({
			Records: [{
				messageId: 'msg-2',
				body: JSON.stringify({
					schemaVersion: 1,
					jobId: jobId.toString(),
					target: 'report',
					workspaceId: workspaceId.toString(),
					requestedBySub: 'user-sub',
					format: 'pdf',
					queuedAt: '2026-03-08T10:00:00.000Z',
				}),
				attributes: { ApproximateReceiveCount: '1' },
			}],
		} as any);

		expect(result).toEqual({ batchItemFailures: [] });
		expect(buildExportPipeline).toHaveBeenCalledWith({
			workspaceId: workspaceId.toString(),
			conditions: [],
			sort: { field: 'product_name', order: 'asc' },
		}, workspaceId, 1000);
		expect(generateReportsPDFExport).toHaveBeenCalledWith(products);
		expect(uploadExportObjectByKey).toHaveBeenCalledWith({
			key: expect.stringContaining(`/reports/${workspaceId.toString()}/${jobId.toString()}/Products_Report_`),
			body: Buffer.from('report-pdf'),
			contentType: 'application/pdf',
		});
		expect(markExportJobCompleted).toHaveBeenCalledWith({
			jobId,
			s3Key: expect.stringContaining(`/reports/${workspaceId.toString()}/${jobId.toString()}/Products_Report_`),
			fileName: expect.stringMatching(/^Products_Report_\d{4}-\d{2}-\d{2}\.pdf$/),
			contentType: 'application/pdf',
		});
	});
});
