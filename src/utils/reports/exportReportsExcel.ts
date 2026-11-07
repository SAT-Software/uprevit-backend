require('core-js/modules/es.promise');
require('core-js/modules/es.string.includes');
require('core-js/modules/es.object.assign');
require('core-js/modules/es.object.keys');
require('core-js/modules/es.symbol');
require('core-js/modules/es.symbol.async-iterator');
require('regenerator-runtime/runtime');

const ExcelJS = require('exceljs/dist/es5');
import { logError } from '../logger';
import { EXPORT_TONES, ExportTone, PRODUCT_STATUSES, ReportExportContext, describeReportFilters, formatExportTimestamp, statusLabel, statusTone } from '../exportFormatting';

interface ProductForExport {
	_id: any;
	product_name: string;
	product_plan_number: string;
	product_description?: string;
	status: string;
	target_date?: Date | null;
	version: number;
	department_id?: any;
	project_id?: any;
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
	compliance_information?: { tab_completed?: boolean };
	symbols_graphics?: { tab_completed?: boolean };
	label_components?: { tab_completed?: boolean };
	label_tags?: { tab_completed?: boolean };
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;
const BORDER = { style: 'thin', color: { argb: argb('#D1D5DB') } };
const BORDER_ALL = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('#5B21B6') } };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('#FAFAFB') } };
const toneFill = (tone: ExportTone) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(EXPORT_TONES[tone].fill) } });
const toneFont = (tone: ExportTone) => ({ bold: true, color: { argb: argb(EXPORT_TONES[tone].text) } });

const SECTIONS: Array<{ key: keyof ProductForExport; label: string }> = [
	{ key: 'product_information', label: 'Product information' },
	{ key: 'compliance_information', label: 'Compliance' },
	{ key: 'symbols_graphics', label: 'Symbols & graphics' },
	{ key: 'label_components', label: 'Label components' },
	{ key: 'label_tags', label: 'Label tags' },
];

const isComplete = (product: ProductForExport, key: keyof ProductForExport): boolean =>
	Boolean((product[key] as { tab_completed?: boolean } | undefined)?.tab_completed);

const styleHeaderRow = (row: any) => {
	row.height = 30;
	row.eachCell((cell: any) => {
		cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = HEADER_FILL;
		cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
		cell.border = BORDER_ALL;
	});
};

const setPrintLayout = (sheet: any, label: string, orientation: 'landscape' | 'portrait', printTitlesRow?: string) => {
	sheet.pageSetup = {
		paperSize: 9,
		orientation,
		fitToPage: true,
		fitToWidth: 1,
		fitToHeight: 0,
		margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
		...(printTitlesRow ? { printTitlesRow } : {}),
	};
	sheet.headerFooter = { oddFooter: `&L&8${label.replace(/&/g, '&&')}&R&8Page &P of &N` };
};

const addSummaryTable = (sheet: any, startRow: number, headers: string[], rows: Array<{ label: string; count: number; tone?: ExportTone }>, total: number) => {
	headers.forEach((header, index) => { sheet.getCell(startRow, index + 1).value = header; });
	styleHeaderRow(sheet.getRow(startRow));
	[2, 3].forEach((col) => { sheet.getCell(startRow, col).alignment = { vertical: 'middle', horizontal: 'right' }; });
	rows.forEach((item, index) => {
		const row = sheet.getRow(startRow + 1 + index);
		row.values = [item.label, item.count, total ? item.count / total : 0];
		row.height = 20;
		row.eachCell({ includeEmpty: true }, (cell: any, col: number) => {
			cell.border = BORDER_ALL;
			cell.alignment = { vertical: 'middle', horizontal: col === 1 ? 'left' : 'right' };
		});
		if (item.tone) {
			row.getCell(1).fill = toneFill(item.tone);
			row.getCell(1).font = toneFont(item.tone);
		}
		row.getCell(3).numFmt = '0%';
	});
	return startRow + rows.length + 1;
};

/**
 * Generates an Excel report export for multiple products.
 * Creates a summary sheet with the status breakdown, and a filterable
 * products sheet with product details, status, dates, market details and completion status.
 * @param {ProductForExport[]} products - Array of products to include in the report
 * @param {ReportExportContext} context - Workspace name and the report query
 * @return {Promise<Buffer | null>} Excel buffer on success, null on failure
 */
export async function generateReportsExcelExport(products: ProductForExport[], context: ReportExportContext = {}): Promise<Buffer | null> {
	try {
		const workbook = new ExcelJS.Workbook();
		workbook.creator = 'Uprevit';
		workbook.title = 'Products report';
		workbook.created = new Date();

		const summary = workbook.addWorksheet('Summary', { views: [{ showGridLines: false }], properties: { tabColor: { argb: argb('#7F22FE') } } });
		summary.columns = [{ width: 28 }, { width: 18 }, { width: 28 }, { width: 8 }];
		summary.getCell('A1').value = 'Products report';
		summary.getCell('A1').font = { bold: true, size: 18, color: { argb: argb('#111827') } };
		summary.getRow(1).height = 28;
		summary.getCell('A2').value = [context.workspaceName, formatExportTimestamp(), `${products.length} ${products.length === 1 ? 'product' : 'products'}`].filter(Boolean).join(' · ');
		summary.getCell('A2').font = { color: { argb: argb('#6B7280') } };

		const filters = describeReportFilters(context);
		['Field', 'Condition', 'Value', 'Join'].forEach((header, index) => { summary.getCell(4, index + 1).value = header; });
		styleHeaderRow(summary.getRow(4));
		(filters.length ? filters : [{ field: 'All products (no filters)', operator: '', value: '', join: undefined }]).forEach((filter, index) => {
			const row = summary.getRow(5 + index);
			row.values = [filter.field, filter.operator, filter.value, filter.join ?? ''];
			row.eachCell({ includeEmpty: true }, (cell: any) => {
				cell.border = BORDER_ALL;
				cell.alignment = { vertical: 'middle', wrapText: true };
			});
			row.getCell(2).font = { color: { argb: argb('#6B7280') } };
			row.getCell(4).font = { bold: true, color: { argb: argb('#6B7280') } };
			row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
		});
		const statusStart = 5 + Math.max(filters.length, 1) + 1;

		const statuses = [...PRODUCT_STATUSES, ...new Set(products.map((product) => product.status).filter((status) => status && !PRODUCT_STATUSES.includes(status)))];
		const statusEnd = addSummaryTable(
			summary,
			statusStart,
			['Status', 'Products', 'Share'],
			statuses.map((status) => ({ label: statusLabel(status), count: products.filter((product) => product.status === status).length, tone: statusTone(status) })),
			products.length,
		);
		const totalRow = summary.getRow(statusEnd);
		totalRow.values = ['Total', products.length, products.length ? 1 : 0];
		totalRow.font = { bold: true };
		totalRow.eachCell({ includeEmpty: true }, (cell: any) => { cell.border = BORDER_ALL; });
		totalRow.height = 22;
		totalRow.getCell(2).alignment = { horizontal: 'right' };
		totalRow.getCell(3).alignment = { horizontal: 'right' };
		totalRow.getCell(3).numFmt = '0%';
		const footerLabel = [context.workspaceName, 'Products report'].filter(Boolean).join(' · ');
		setPrintLayout(summary, footerLabel, 'portrait');

		const sheet = workbook.addWorksheet('Products', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
		sheet.columns = [
			{ header: 'Product name', key: 'product_name', width: 34 },
			{ header: 'Description', key: 'product_description', width: 50 },
			{ header: 'Plan number', key: 'product_plan_number', width: 16 },
			{ header: 'Status', key: 'status', width: 13 },
			{ header: 'Version', key: 'version', width: 9 },
			{ header: 'Target date', key: 'target_date', width: 14 },
			{ header: 'Market geography', key: 'market_geography', width: 20 },
			{ header: 'Country of origin', key: 'country_of_origin', width: 18 },
			{ header: 'OEM / contract manufacturer', key: 'oem_contract_manufacturer', width: 20 },
			{ header: 'Commercial / clinical', key: 'commercial_clinical', width: 16 },
			{ header: 'Manufacturing location', key: 'manufacturing_location', width: 22 },
			{ header: 'Class of device', key: 'class_of_device', width: 15 },
			{ header: 'Basic UDI-DI', key: 'basic_udi_di', width: 20 },
			...SECTIONS.map(({ key, label }) => ({ header: `${label} complete`, key, width: 14 })),
			{ header: 'Sections done', key: 'sections_done', width: 12 },
		];
		styleHeaderRow(sheet.getRow(1));

		products.forEach((product, index) => {
			const info = product.product_information?.data;
			const targetDate = product.target_date ? new Date(product.target_date) : undefined;
			const row = sheet.addRow({
				product_name: product.product_name || '',
				product_plan_number: product.product_plan_number || '',
				status: statusLabel(product.status),
				version: product.version ?? '',
				target_date: targetDate && !Number.isNaN(targetDate.getTime()) ? targetDate : '',
				market_geography: info?.market_geography || '',
				country_of_origin: info?.country_of_origin || '',
				oem_contract_manufacturer: info?.oem_contract_manufacturer || '',
				commercial_clinical: info?.commercial_clinical || '',
				manufacturing_location: info?.manufacturing_location || '',
				class_of_device: info?.class_of_device || '',
				basic_udi_di: info?.basic_udi_di || '',
				...Object.fromEntries(SECTIONS.map(({ key }) => [key, isComplete(product, key) ? 'Yes' : 'No'])),
				sections_done: SECTIONS.filter(({ key }) => isComplete(product, key)).length,
				product_description: product.product_description || '',
			});
			row.eachCell({ includeEmpty: true }, (cell: any) => {
				cell.alignment = { vertical: 'top', wrapText: true };
				cell.border = BORDER_ALL;
				if (index % 2 === 1) cell.fill = ZEBRA_FILL;
			});
			row.getCell('product_name').font = { bold: true };
			row.getCell('target_date').numFmt = 'dd mmm yyyy';
			row.getCell('version').alignment = { vertical: 'top', horizontal: 'right' };
			row.getCell('sections_done').numFmt = '0 "of 5"';
			row.getCell('sections_done').alignment = { vertical: 'top', horizontal: 'right' };
			if (product.status) {
				const tone = statusTone(product.status);
				row.getCell('status').fill = toneFill(tone);
				row.getCell('status').font = toneFont(tone);
			}
			SECTIONS.forEach(({ key }) => {
				const cell = row.getCell(key);
				cell.alignment = { vertical: 'top', horizontal: 'center' };
				cell.font = isComplete(product, key) ? toneFont('green') : { color: { argb: argb('#9CA3AF') } };
			});
		});

		sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: products.length + 1, column: sheet.columns.length } };
		setPrintLayout(sheet, footerLabel, 'landscape', '1:1');

		const buffer = await workbook.xlsx.writeBuffer();
		return Buffer.from(buffer);
	} catch (error) {
		logError('Reports Excel export failed', error);
		return null;
	}
}
