import { logError } from '../logger';
import { PRODUCT_STATUSES, ReportExportContext, describeReportFilters, formatExportDate, statusLabel, statusTone } from '../exportFormatting';
import { createPdfLayout } from '../pdfLayout';

interface ProductForExport {
	_id: any;
	product_name: string;
	product_plan_number: string;
	product_description?: string;
	status: string;
	target_date?: Date | null;
	version: number;
	product_information?: {
		data?: {
			market_geography?: string;
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

const completedSections = (product: ProductForExport): number =>
	[product.product_information, product.compliance_information, product.symbols_graphics, product.label_components, product.label_tags].filter((section) => section?.tab_completed).length;

/**
 * Generates a PDF report export for multiple products.
 * Creates a branded document with a status summary and a product table covering
 * name, plan number, status, version, target date, market, class, UDI, completion and description.
 * @param {ProductForExport[]} products - Array of products to include in the report
 * @param {ReportExportContext} context - Workspace name and the report query
 * @return {Promise<Buffer | null>} PDF buffer on success, null on failure
 */
export async function generateReportsPDFExport(products: ProductForExport[], context: ReportExportContext = {}): Promise<Buffer | null> {
	try {
		const layout = await createPdfLayout('Products report', context.workspaceName);
		const statuses = [...PRODUCT_STATUSES, ...new Set(products.map((product) => product.status).filter((status) => status && !PRODUCT_STATUSES.includes(status)))];

		layout.titleBlock({
			heading: 'Products report',
			meta: [`${products.length} ${products.length === 1 ? 'product' : 'products'}`, layout.generatedAt],
		});

		layout.filters(describeReportFilters(context));

		layout.stats([
			{ label: 'Total products', value: products.length },
			...statuses.map((status) => ({ label: statusLabel(status), value: products.filter((product) => product.status === status).length })),
		]);

		layout.heading('Products', products.length);
		if (!products.length) {
			layout.emptyNote('No products match this report.');
			return await layout.finish();
		}

		layout.table(
			[
				{ label: 'Product', weight: 0.17 },
				{ label: 'Description', weight: 0.2, maxLines: 3 },
				{ label: 'Status', weight: 0.08 },
				{ label: 'Version', weight: 0.06, align: 'right' },
				{ label: 'Target date', weight: 0.09 },
				{ label: 'Market geography', weight: 0.1 },
				{ label: 'Class of device', weight: 0.08 },
				{ label: 'Basic UDI-DI', weight: 0.13 },
				{ label: 'Sections done', weight: 0.07, align: 'right' },
			],
			products.map((product) => {
				const info = product.product_information?.data;
				return [
					{ text: product.product_name, subtext: product.product_plan_number, format: { bold: true } },
					{ text: product.product_description, muted: true },
					product.status ? { pill: { text: statusLabel(product.status), tone: statusTone(product.status) } } : {},
					{ text: product.version ? `v${product.version}` : '' },
					{ text: formatExportDate(product.target_date) },
					{ text: info?.market_geography },
					{ text: info?.class_of_device },
					{ text: info?.basic_udi_di },
					{ text: `${completedSections(product)} of 5` },
				];
			}),
		);

		return await layout.finish();
	} catch (error) {
		logError('Reports PDF export failed', error);
		return null;
	}
}
