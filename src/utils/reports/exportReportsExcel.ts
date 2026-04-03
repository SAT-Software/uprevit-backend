require('core-js/modules/es.promise');
require('core-js/modules/es.string.includes');
require('core-js/modules/es.object.assign');
require('core-js/modules/es.object.keys');
require('core-js/modules/es.symbol');
require('core-js/modules/es.symbol.async-iterator');
require('regenerator-runtime/runtime');

const ExcelJS = require('exceljs/dist/es5');
import { logError } from '../logger';

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
}

/**
 * Generates an Excel report export for multiple products.
 * Creates a single-sheet workbook with product information including
 * name, plan number, description, status, market details, dates, and completion status.
 * @param {ProductForExport[]} products - Array of products to include in the report
 * @return {Promise<Buffer | null>} Excel buffer on success, null on failure
 */
export async function generateReportsExcelExport(products: ProductForExport[]): Promise<Buffer | null> {
	try {
		const workbook = new ExcelJS.Workbook();
		workbook.creator = 'Uprevit Reports';
		workbook.created = new Date();

		const sheet = workbook.addWorksheet('Products', {
			pageSetup: { paperSize: 9, orientation: 'landscape' },
		});
		sheet.columns = [
			{ header: 'Product Name', key: 'product_name', width: 30 },
			{ header: 'Plan Number', key: 'product_plan_number', width: 20 },
			{ header: 'Description', key: 'product_description', width: 40 },
			{ header: 'Status', key: 'status', width: 12 },
			{ header: 'Version', key: 'version', width: 10 },
			{ header: 'Target Date', key: 'target_date', width: 15 },
			{ header: 'Market Geography', key: 'market_geography', width: 20 },
			{ header: 'Country of Origin', key: 'country_of_origin', width: 18 },
			{ header: 'OEM/Contract', key: 'oem_contract_manufacturer', width: 18 },
			{ header: 'Commercial/Clinical', key: 'commercial_clinical', width: 18 },
			{ header: 'Manufacturing Location', key: 'manufacturing_location', width: 20 },
			{ header: 'Product Info Complete', key: 'product_info_complete', width: 18 },
			{ header: 'Compliance Complete', key: 'compliance_complete', width: 18 },
			{ header: 'Symbols Complete', key: 'symbols_complete', width: 16 },
			{ header: 'Components Complete', key: 'components_complete', width: 18 },
			{ header: 'Label Tags Complete', key: 'label_tags_complete', width: 18 },
		];

		const headerRow = sheet.getRow(1);
		headerRow.font = { bold: true };
		headerRow.fill = {
			type: 'pattern',
			pattern: 'solid',
			fgColor: { argb: 'FFC9DAF8' }, // Light blue
		};
		headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

		products.forEach((product) => {
			const productInfo = product.product_information?.data;
			sheet.addRow({
				product_name: product.product_name || '',
				product_plan_number: product.product_plan_number || '',
				product_description: product.product_description || '',
				status: product.status || '',
				version: product.version || '',
				target_date: product.target_date ? new Date(product.target_date).toLocaleDateString() : '',
				market_geography: productInfo?.market_geography || '',
				country_of_origin: productInfo?.country_of_origin || '',
				oem_contract_manufacturer: productInfo?.oem_contract_manufacturer || '',
				commercial_clinical: productInfo?.commercial_clinical || '',
				manufacturing_location: productInfo?.manufacturing_location || '',
				product_info_complete: product.product_information?.tab_completed ? 'Yes' : 'No',
				compliance_complete: product.compliance_information?.tab_completed ? 'Yes' : 'No',
				symbols_complete: product.symbols_graphics?.tab_completed ? 'Yes' : 'No',
				components_complete: product.label_components?.tab_completed ? 'Yes' : 'No',
				label_tags_complete: product.label_tags?.tab_completed ? 'Yes' : 'No',
			});
		});

		sheet.eachRow((row: any, rowNumber: number) => {
			row.eachCell((cell: any) => {
				cell.border = {
					top: { style: 'thin' },
					left: { style: 'thin' },
					bottom: { style: 'thin' },
					right: { style: 'thin' },
				};
			});
			if (rowNumber > 1 && rowNumber % 2 === 0) {
				row.fill = {
					type: 'pattern',
					pattern: 'solid',
					fgColor: { argb: 'FFF5F5F5' },
				};
			}
		});

		const summarySheet = workbook.addWorksheet('Summary', {
			pageSetup: { paperSize: 9, orientation: 'portrait' },
		});

		summarySheet.columns = [
			{ header: 'Metric', key: 'metric', width: 30 },
			{ header: 'Value', key: 'value', width: 20 },
		];

		const summaryHeaderRow = summarySheet.getRow(1);
		summaryHeaderRow.font = { bold: true };
		summaryHeaderRow.fill = {
			type: 'pattern',
			pattern: 'solid',
			fgColor: { argb: 'FFC9DAF8' },
		};

		const statusCounts: Record<string, number> = {};
		products.forEach((p) => {
			statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
		});
		summarySheet.addRow({ metric: 'Total Products', value: products.length });
		summarySheet.addRow({ metric: 'Report Generated', value: new Date().toLocaleString() });
		summarySheet.addRow({ metric: '', value: '' }); // Empty row
		summarySheet.addRow({ metric: 'Status Breakdown', value: '' });
		Object.entries(statusCounts).forEach(([status, count]) => {
			summarySheet.addRow({ metric: `  ${status}`, value: count });
		});

		summarySheet.eachRow((row: any) => {
			row.eachCell((cell: any) => {
				cell.border = {
					top: { style: 'thin' },
					left: { style: 'thin' },
					bottom: { style: 'thin' },
					right: { style: 'thin' },
				};
			});
		});

		const buffer = await workbook.xlsx.writeBuffer();
		return buffer;
	} catch (error) {
		logError('Reports Excel export failed', error);
		return null;
	}
}
