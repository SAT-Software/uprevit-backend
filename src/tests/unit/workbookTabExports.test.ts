import { describe, expect, it } from '@jest/globals';
import type { Product } from '../../models/product';

process.env.AWS_REGION ??= 'us-east-1';
process.env.UPLOADS_BUCKET ??= 'uploads-bucket';
process.env.EXPORTS_BUCKET ??= 'exports-bucket';

const ExcelJS = require('exceljs');
const { generateWorkbookTabExcelExport } = require('../../utils/exportExcel');

const workbook = (value: string) => ({
	data: {
		workbook_data: {
			cells: { '0,0': 'Spec', '1,0': value },
			headers: { 0: 'Field' },
			columnTypes: { 0: 'constant' },
			rowOrder: [0, 1],
			columnOrder: ['col-0'],
			columnCount: 1,
		},
	},
});

const product = {
	product_name: 'Widget',
	product_plan_number: 'ABC1234567',
	version: 1,
	product_data: workbook('value-one'),
	operational_parameters: workbook('value-two'),
} as unknown as Product;

const sheetValues = async (buffer: Buffer) => {
	const loaded = new ExcelJS.Workbook();
	await loaded.xlsx.load(buffer);
	const values: string[] = [];
	loaded.worksheets.forEach((sheet: any) => sheet.eachRow((row: any) => row.eachCell((cell: any) => values.push(String(cell.value)))));
	return { names: loaded.worksheets.map((sheet: any) => sheet.name), values };
};

describe('workbook tab exports', () => {
	it('exports the specifications tab as one sheet', async () => {
		const { names, values } = await sheetValues(await generateWorkbookTabExcelExport(product, 'product_specifications'));

		expect(names).toEqual(['Product Specifications']);
		expect(values).toContain('value-one');
	});

	it('exports the operational parameters tab as one sheet', async () => {
		const { names, values } = await sheetValues(await generateWorkbookTabExcelExport(product, 'operational_parameters'));

		expect(names).toEqual(['Operational Parameters']);
		expect(values).toContain('value-two');
	});

	it('exports an empty tab without failing', async () => {
		const empty = { ...product, product_data: undefined } as unknown as Product;
		const { names } = await sheetValues(await generateWorkbookTabExcelExport(empty, 'product_specifications'));

		expect(names).toEqual(['Product Specifications']);
	});
});
