import { PDFDocument, rgb, StandardFonts, PDFPage } from 'pdf-lib';
import { logError } from '../logger';

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 25;
const FOOTER_HEIGHT = 25;

const HEADER_BG_COLOR = rgb(0.788, 0.855, 0.973);
const HEADER_TEXT_COLOR = rgb(0, 0, 0);
const BORDER_COLOR = rgb(0, 0, 0);

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
}

/**
 * Generates a PDF report export for multiple products.
 * Creates a tabular PDF document with product information including
 * name, plan number, status, market geography, target date, and completion status.
 * @param {ProductForExport[]} products - Array of products to include in the report
 * @return {Promise<Buffer | null>} PDF buffer on success, null on failure
 */
export async function generateReportsPDFExport(products: ProductForExport[]): Promise<Buffer | null> {
	try {
		const pdfDoc = await PDFDocument.create();
		const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
		const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

		const pages: PDFPage[] = [];
		let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
		pages.push(page);
		let y = PAGE_HEIGHT - MARGIN - HEADER_HEIGHT;

		const addNewPage = (): PDFPage => {
			page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
			pages.push(page);
			y = PAGE_HEIGHT - MARGIN - HEADER_HEIGHT;
			return page;
		};

		const drawTextInCell = (
			text: string,
			x: number,
			cellY: number,
			width: number,
			isBold: boolean,
			currentPage: PDFPage
		) => {
			const size = 8;
			const font = isBold ? fontBold : fontRegular;
			let cleanText = String(text || '').replace(/\s+/g, ' ').trim();

			const textWidth = font.widthOfTextAtSize(cleanText, size);
			if (textWidth > width - 6) {
				const maxChars = Math.floor((width - 6) / 4.5);
				cleanText = cleanText.substring(0, maxChars) + '...';
			}

			currentPage.drawText(cleanText, {
				x: x + 3,
				y: cellY - 14,
				size: size,
				font: font,
				color: rgb(0, 0, 0),
			});
		};

		const columns = [
			{ label: 'Product Name', widthPct: 0.16 },
			{ label: 'Plan Number', widthPct: 0.11 },
			{ label: 'Status', widthPct: 0.08 },
			{ label: 'Version', widthPct: 0.06 },
			{ label: 'Target Date', widthPct: 0.10 },
			{ label: 'Market Geography', widthPct: 0.13 },
			{ label: 'Class of Device', widthPct: 0.13 },
			{ label: 'Basic UDI-DI', widthPct: 0.13 },
			{ label: 'Description', widthPct: 0.10 },
		];

		const colWidths = columns.map((h) => h.widthPct * CONTENT_WIDTH);

		page.drawText('Products Report', {
			x: MARGIN,
			y: y,
			size: 14,
			font: fontBold,
			color: rgb(0.2, 0.3, 0.6),
		});
		y -= 25;

		page.drawText(`Total Products: ${products.length}`, {
			x: MARGIN,
			y: y,
			size: 10,
			font: fontRegular,
			color: rgb(0.3, 0.3, 0.3),
		});
		y -= 20;

		const drawHeader = () => {
			page.drawRectangle({
				x: MARGIN,
				y: y - 18,
				width: CONTENT_WIDTH,
				height: 18,
				color: HEADER_BG_COLOR,
				borderColor: BORDER_COLOR,
				borderWidth: 1,
			});

			let currentX = MARGIN;
			columns.forEach((h, i) => {
				page.drawRectangle({
					x: currentX,
					y: y - 18,
					width: colWidths[i],
					height: 18,
					borderColor: BORDER_COLOR,
					borderWidth: 0.5,
				});

				const fontSize = 8;
				let headerText = h.label;
				const textWidth = fontBold.widthOfTextAtSize(headerText, fontSize);
				if (textWidth > colWidths[i] - 6) {
					const maxChars = Math.floor((colWidths[i] - 6) / 4.5);
					headerText = headerText.substring(0, maxChars) + '...';
				}

				page.drawText(headerText, {
					x: currentX + 3,
					y: y - 12,
					size: fontSize,
					font: fontBold,
					color: HEADER_TEXT_COLOR,
				});
				currentX += colWidths[i];
			});
			y -= 18;
		};

		drawHeader();

		products.forEach((product, rowIndex) => {
			if (y < MARGIN + FOOTER_HEIGHT + ROW_HEIGHT) {
				addNewPage();
				drawHeader();
			}

			if (rowIndex % 2 === 1) {
				page.drawRectangle({
					x: MARGIN,
					y: y - ROW_HEIGHT,
					width: CONTENT_WIDTH,
					height: ROW_HEIGHT,
					color: rgb(0.96, 0.96, 0.96),
				});
			}

			const rowData = [
				product.product_name || '',
				product.product_plan_number || '',
				product.status || '',
				String(product.version || ''),
				product.target_date ? new Date(product.target_date).toLocaleDateString() : '',
				product.product_information?.data?.market_geography || '',
				product.product_information?.data?.class_of_device || '',
				product.product_information?.data?.basic_udi_di || '',
				product.product_description || '',
			];

			let currentX = MARGIN;
			rowData.forEach((cellData, colIndex) => {
				page.drawRectangle({
					x: currentX,
					y: y - ROW_HEIGHT,
					width: colWidths[colIndex],
					height: ROW_HEIGHT,
					borderColor: BORDER_COLOR,
					borderWidth: 0.5,
				});

				drawTextInCell(cellData, currentX, y, colWidths[colIndex], false, page);
				currentX += colWidths[colIndex];
			});

			y -= ROW_HEIGHT;
		});

		const totalPages = pages.length;
		pages.forEach((p, index) => {
			const pageNumber = index + 1;

			const headerText = 'Products Report';
			const headerFontSize = 10;
			const headerTextWidth = fontRegular.widthOfTextAtSize(headerText, headerFontSize);
			p.drawText(headerText, {
				x: PAGE_WIDTH - MARGIN - headerTextWidth,
				y: PAGE_HEIGHT - MARGIN + 5,
				size: headerFontSize,
				font: fontRegular,
				color: rgb(0.4, 0.4, 0.4),
			});

			const footerText = `Page ${pageNumber} of ${totalPages}`;
			const footerFontSize = 9;
			const footerTextWidth = fontRegular.widthOfTextAtSize(footerText, footerFontSize);
			p.drawText(footerText, {
				x: PAGE_WIDTH - MARGIN - footerTextWidth,
				y: MARGIN - 15,
				size: footerFontSize,
				font: fontRegular,
				color: rgb(0.4, 0.4, 0.4),
			});

			const dateText = `Generated: ${new Date().toLocaleString()}`;
			p.drawText(dateText, {
				x: MARGIN,
				y: MARGIN - 15,
				size: footerFontSize,
				font: fontRegular,
				color: rgb(0.4, 0.4, 0.4),
			});
		});

		const pdfBytes = await pdfDoc.save();
		return Buffer.from(pdfBytes);
	} catch (error) {
		logError('Reports PDF export failed', error);
		return null;
	}
}
