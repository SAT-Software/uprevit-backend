import { PDFDocument, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { Product } from "../models/product";
import transformUniverExcelData from "./transformUniverExcelData";
import { logError } from "./logger";
import { createPresignedGetUrlMap } from "./s3-storage";

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const SECTION_TITLE_SPACING = 20;
const TABLE_HEADER_HEIGHT = 20;
const TABLE_ROW_HEIGHT = 25;
const TABLE_IMAGE_ROW_HEIGHT = 95;
const TABLE_BOTTOM_SPACING = 20;
const TOP_HEADER_HEIGHT = 26;
const BOTTOM_PADDING = 20;
const IMAGE_PADDING = 6;

const HEADER_BG_COLOR = rgb(0.788, 0.855, 0.973);
const HEADER_TEXT_COLOR = rgb(0, 0, 0);
const BORDER_COLOR = rgb(0, 0, 0);
const BODY_TEXT_COLOR = rgb(0, 0, 0);
const TOP_META_TEXT_COLOR = rgb(0.45, 0.45, 0.45);
const PLACEHOLDER_TEXT_COLOR = rgb(0.5, 0.5, 0.5);

type TableHeader = {
	label: string;
	widthPct: number;
};

type TableCell = {
	text?: string;
	imageUrl?: string;
};

type TableRow = {
	cells: TableCell[];
	isImageRow?: boolean;
};

type EmbeddedAsset = {
	image?: PDFImage;
	placeholderText?: string;
};

const toCleanString = (value: unknown): string => {
	if (value === null || value === undefined) return "";
	return String(value).replace(/\s+/g, " ").trim();
};

const toOptionalString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const toS3Key = (value: unknown): string | undefined => {
	const parsed = toOptionalString(value);
	if (!parsed) return undefined;
	return parsed.startsWith("uploads/") ? parsed : undefined;
};

const isLikelyWebpUrl = (url: string): boolean => {
	const normalized = url.toLowerCase();
	if (normalized.startsWith("data:image/webp")) return true;

	try {
		return new URL(url).pathname.toLowerCase().endsWith(".webp");
	} catch {
		return normalized.split("?")[0].split("#")[0].endsWith(".webp");
	}
};

const isWebpBytes = (bytes: Uint8Array): boolean => {
	if (bytes.length < 12) return false;
	return (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
};

const getImageFormat = (
	bytes: Uint8Array,
	contentType: string | null,
	url: string,
): "png" | "jpg" | "webp" | null => {
	const normalizedContentType = (contentType || "").toLowerCase();

	if (normalizedContentType.includes("image/webp") || isLikelyWebpUrl(url) || isWebpBytes(bytes)) {
		return "webp";
	}

	if (normalizedContentType.includes("image/png")) return "png";
	if (normalizedContentType.includes("image/jpeg") || normalizedContentType.includes("image/jpg")) return "jpg";

	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "png";
	}

	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";

	return null;
};

const resolveImageUrl = (
	imageValue: unknown,
	keyValue: unknown,
	signedUrlMap: Map<string, string>,
): string | undefined => {
	const directUrl = toOptionalString(imageValue);
	const explicitKey = toS3Key(keyValue);
	const keyFromImage = toS3Key(directUrl);
	const s3Key = explicitKey || keyFromImage;

	if (s3Key) {
		const signedUrl = signedUrlMap.get(s3Key);
		if (signedUrl) return signedUrl;
		if (directUrl && !directUrl.startsWith("uploads/")) return directUrl;
		return undefined;
	}

	return directUrl;
};

const getPreferredLabelTagImageUrl = (
	item: Product["label_tags"]["data"][number],
	signedUrlMap: Map<string, string>,
): string | undefined => {
	const taggedImageUrl = resolveImageUrl(item.tagged_image, item.tagged_image_key, signedUrlMap);
	if (taggedImageUrl) return taggedImageUrl;
	return resolveImageUrl(item.image, item.key, signedUrlMap);
};

const collectProductImageS3Keys = (productData: Product): string[] => {
	const keys = new Set<string>();
	const addKey = (value: unknown) => {
		const key = toS3Key(value);
		if (key) keys.add(key);
	};

	(productData.label_components?.data || []).forEach((item) => {
		addKey(item.key);
		addKey(item.image);
	});

	(productData.symbols_graphics?.data || []).forEach((item) => {
		addKey(item.key);
		addKey(item.image);
	});

	(productData.label_tags?.data || []).forEach((item) => {
		addKey(item.key);
		addKey(item.image);
		addKey(item.tagged_image_key);
		addKey(item.tagged_image);
	});

	return [...keys];
};

const loadSignedUrlMap = async (productData: Product): Promise<Map<string, string>> => {
	const s3Keys = collectProductImageS3Keys(productData);
	if (!s3Keys.length) return new Map<string, string>();

	try {
		return await createPresignedGetUrlMap(s3Keys);
	} catch (error) {
		logError("Failed to sign product image URLs for PDF export", error);
		return new Map<string, string>();
	}
};

const appendDataAndImageRows = (
	rows: TableRow[],
	dataCells: string[],
	imageCells: { colIndex: number; imageUrl?: string }[],
) => {
	const imageColumnIndexes = new Set<number>(imageCells.map((item) => item.colIndex));
	rows.push({
		cells: dataCells.map((cell, index) => ({
			text: imageColumnIndexes.has(index) ? "" : cell,
		})),
	});

	if (!imageCells.some((item) => Boolean(item.imageUrl))) return;

	const imageByIndex = new Map<number, string>();
	imageCells.forEach((item) => {
		if (item.imageUrl) imageByIndex.set(item.colIndex, item.imageUrl);
	});

	rows.push({
		isImageRow: true,
		cells: dataCells.map((_, index) => ({
			imageUrl: imageByIndex.get(index),
			text: "",
		})),
	});
};

const toTextRows = (rows: unknown[][]): TableRow[] => {
	return rows.map((row) => ({
		cells: row.map((cell) => ({ text: toCleanString(cell) })),
	}));
};

const normalizeTableRow = (row: TableRow, targetColumns: number): TableCell[] => {
	const normalizedCells: TableCell[] = [];
	for (let i = 0; i < targetColumns; i += 1) {
		normalizedCells.push(row.cells[i] || { text: "" });
	}
	return normalizedCells;
};

const embedImageAsset = async (
	pdfDoc: PDFDocument,
	url: string,
): Promise<EmbeddedAsset> => {
	if (isLikelyWebpUrl(url)) return { placeholderText: "WEBP not supported" };

	try {
		const response = await fetch(url);
		if (!response.ok) return { placeholderText: "Image unavailable" };

		const bytes = new Uint8Array(await response.arrayBuffer());
		const format = getImageFormat(bytes, response.headers.get("content-type"), url);

		if (format === "webp") return { placeholderText: "WEBP not supported" };
		if (format === "png") return { image: await pdfDoc.embedPng(bytes) };
		if (format === "jpg") return { image: await pdfDoc.embedJpg(bytes) };

		return { placeholderText: "Unsupported image" };
	} catch {
		return { placeholderText: "Image unavailable" };
	}
};

const preloadEmbeddedAssets = async (
	pdfDoc: PDFDocument,
	urls: string[],
): Promise<Map<string, EmbeddedAsset>> => {
	const uniqueUrls = [...new Set(urls.filter(Boolean))];
	const entries = await Promise.all(
		uniqueUrls.map(async (url) => [url, await embedImageAsset(pdfDoc, url)] as const),
	);
	return new Map(entries);
};

/**
 * Generates a PDF export of product data.
 * Creates a multi-page PDF document with sections for product information,
 * compliance, label components, symbols, barcodes, and other product data.
 * @param {Product} productData - The product data to export
 * @return {Promise<Buffer | null>} PDF buffer on success, null on failure
 */
export async function generateProductPDFExport(productData: Product) {
	try {
		const pdfDoc = await PDFDocument.create();
		const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
		const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
		const productName = productData.product_name || "Product Export";

		const signedUrlMap = await loadSignedUrlMap(productData);

		const infoRows: TableRow[] = [];
		const infoRawRows: unknown[][] = [
			["Product Name", productData.product_name || ""],
			["Product Description", productData.product_description || ""],
			["Product Plan Number", productData.product_plan_number || ""],
		];

		if (productData.product_information?.data) {
			const d = productData.product_information.data;
			infoRawRows.push(
				["Market Geography", d.market_geography],
				["Country of Origin", d.country_of_origin],
				["OEM/Contract", d.oem_contract_manufacturer],
				["Commercial/Clinical", d.commercial_clinical],
				["Manufacturing Location", d.manufacturing_location],
			);
		}

		(productData.product_information?.custom_fields || []).forEach((field) => {
			infoRawRows.push([field.label, field.value]);
		});
		infoRows.push(...toTextRows(infoRawRows));

		const complianceRows = toTextRows(
			(productData.compliance_information?.data || []).map((item) => [
				item.standard,
				item.standard_description,
			]),
		);

		const labelComponentsRows: TableRow[] = [];
		(productData.label_components?.data || []).forEach((item) => {
			appendDataAndImageRows(
				labelComponentsRows,
				[
					toCleanString(item.component_number),
					"",
					toCleanString(item.component_description),
					Array.isArray(item.label_type) ? item.label_type.join(", ") : "",
					toCleanString(item.dimensions),
					toCleanString(item.component_type),
				],
				[
					{
						colIndex: 1,
						imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
					},
				],
			);
		});

		const symbolsRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Symbols") || []).forEach((item) => {
			appendDataAndImageRows(
				symbolsRows,
				[
					toCleanString(item.text),
					"",
					item.text_present === undefined ? "" : item.text_present ? "Yes" : "No",
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
				],
				[
					{
						colIndex: 1,
						imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
					},
				],
			);
		});

		const schematicsRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Schematics") || []).forEach((item) => {
			appendDataAndImageRows(
				schematicsRows,
				[
					toCleanString(item.text),
					"",
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					toCleanString(item.description),
				],
				[
					{
						colIndex: 1,
						imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
					},
				],
			);
		});

		const barcodesRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Barcodes") || []).forEach((item) => {
			appendDataAndImageRows(
				barcodesRows,
				[
					toCleanString(item.text),
					"",
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					toCleanString(item.count ?? 1),
					toCleanString(item.description),
				],
				[
					{
						colIndex: 1,
						imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
					},
				],
			);
		});

		const otherComponentsRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Other Components") || []).forEach((item) => {
			appendDataAndImageRows(
				otherComponentsRows,
				[
					toCleanString(item.text),
					"",
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					toCleanString(item.description),
				],
				[
					{
						colIndex: 1,
						imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
					},
				],
			);
		});

		const labelTagsRows: TableRow[] = [];
		(productData.label_tags?.data || []).forEach((item) => {
			appendDataAndImageRows(
				labelTagsRows,
				[
					toCleanString(item.name),
					toCleanString(item.description),
					toCleanString(item.type),
					"",
				],
				[
					{
						colIndex: 3,
						imageUrl: getPreferredLabelTagImageUrl(item, signedUrlMap),
					},
				],
			);
		});

		const pData = transformUniverExcelData(productData.product_data?.data);
		const productSpecsHeaders: TableHeader[] = [];
		const productSpecsRows: TableRow[] = [];
		if (pData.sheets.length > 0 && pData.sheets[0].data.length > 0) {
			const headerRow = pData.sheets[0].data[0];
			const dataRows = pData.sheets[0].data.slice(1);
			const colCount = Math.max(headerRow.length, 1);

			headerRow.forEach((headerText: unknown, index: number) => {
				productSpecsHeaders.push({
					label: toCleanString(headerText) || `Column ${index + 1}`,
					widthPct: 1 / colCount,
				});
			});

			dataRows.forEach((row) => {
				productSpecsRows.push({
					cells: [...Array(colCount)].map((_, idx) => ({ text: toCleanString(row[idx]) })),
				});
			});
		}

		const opData = transformUniverExcelData(productData.operational_parameters?.data);
		const operationalHeaders: TableHeader[] = [];
		const operationalRows: TableRow[] = [];
		if (opData.sheets.length > 0 && opData.sheets[0].data.length > 0) {
			const headerRow = opData.sheets[0].data[0];
			const dataRows = opData.sheets[0].data.slice(1);
			const colCount = Math.max(headerRow.length, 1);

			headerRow.forEach((headerText: unknown, index: number) => {
				operationalHeaders.push({
					label: toCleanString(headerText) || `Column ${index + 1}`,
					widthPct: 1 / colCount,
				});
			});

			dataRows.forEach((row) => {
				operationalRows.push({
					cells: [...Array(colCount)].map((_, idx) => ({ text: toCleanString(row[idx]) })),
				});
			});
		}

		const allRows = [
			...labelComponentsRows,
			...symbolsRows,
			...schematicsRows,
			...barcodesRows,
			...otherComponentsRows,
			...labelTagsRows,
		];
		const allImageUrls = allRows.flatMap((row) => row.cells.map((cell) => cell.imageUrl || "")).filter(Boolean);
		const embeddedAssetMap = await preloadEmbeddedAssets(pdfDoc, allImageUrls);

		const pages: PDFPage[] = [];
		let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
		pages.push(page);
		let y = PAGE_HEIGHT - MARGIN - TOP_HEADER_HEIGHT;

		const addNewPage = () => {
			page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
			pages.push(page);
			y = PAGE_HEIGHT - MARGIN - TOP_HEADER_HEIGHT;
			return page;
		};

		const trimTextToWidth = (text: string, maxWidth: number, isBold = false): string => {
			const baseText = toCleanString(text);
			if (!baseText) return "";

			const font = isBold ? fontBold : fontRegular;
			if (font.widthOfTextAtSize(baseText, 9) <= maxWidth) return baseText;

			let trimmed = baseText;
			while (trimmed.length > 3 && font.widthOfTextAtSize(`${trimmed}...`, 9) > maxWidth) {
				trimmed = trimmed.slice(0, -1);
			}

			return trimmed.length <= 3 ? baseText.slice(0, 3) : `${trimmed}...`;
		};

		const drawTextInCell = (
			text: string,
			x: number,
			rowTopY: number,
			cellWidth: number,
			rowHeight: number,
			isBold = false,
			color = BODY_TEXT_COLOR,
		) => {
			const fontSize = 9;
			const safeText = trimTextToWidth(text, Math.max(1, cellWidth - 8), isBold);
			const textY = rowTopY - rowHeight + (rowHeight - fontSize) / 2;

			page.drawText(safeText, {
				x: x + 4,
				y: textY,
				size: fontSize,
				font: isBold ? fontBold : fontRegular,
				color,
			});
		};

		const drawImageInCell = (asset: EmbeddedAsset, x: number, rowTopY: number, cellWidth: number, rowHeight: number) => {
			if (!asset.image) {
				drawTextInCell(asset.placeholderText || "Image unavailable", x, rowTopY, cellWidth, rowHeight, false, PLACEHOLDER_TEXT_COLOR);
				return;
			}

			const availableWidth = Math.max(cellWidth - IMAGE_PADDING * 2, 1);
			const availableHeight = Math.max(rowHeight - IMAGE_PADDING * 2, 1);
			const scale = Math.min(
				availableWidth / asset.image.width,
				availableHeight / asset.image.height,
				1,
			);
			const drawWidth = asset.image.width * scale;
			const drawHeight = asset.image.height * scale;
			const drawX = x + (cellWidth - drawWidth) / 2;
			const rowBottom = rowTopY - rowHeight;
			const drawY = rowBottom + (rowHeight - drawHeight) / 2;

			page.drawImage(asset.image, {
				x: drawX,
				y: drawY,
				width: drawWidth,
				height: drawHeight,
			});
		};

		const drawTable = (
			title: string,
			headers: TableHeader[],
			rows: TableRow[],
			startNewPage = false,
		) => {
			if (startNewPage && pages.length > 0) addNewPage();

			if (y < MARGIN + BOTTOM_PADDING + 80) addNewPage();

			page.drawText(title, {
				x: MARGIN,
				y,
				size: 14,
				font: fontBold,
				color: rgb(0.2, 0.3, 0.6),
			});
			y -= SECTION_TITLE_SPACING;

			const colWidths = headers.map((header) => header.widthPct * CONTENT_WIDTH);

			const drawHeader = () => {
				page.drawRectangle({
					x: MARGIN,
					y: y - TABLE_HEADER_HEIGHT,
					width: CONTENT_WIDTH,
					height: TABLE_HEADER_HEIGHT,
					color: HEADER_BG_COLOR,
					borderColor: BORDER_COLOR,
					borderWidth: 1,
				});

				let currentX = MARGIN;
				headers.forEach((header, index) => {
					page.drawRectangle({
						x: currentX,
						y: y - TABLE_HEADER_HEIGHT,
						width: colWidths[index],
						height: TABLE_HEADER_HEIGHT,
						borderColor: BORDER_COLOR,
						borderWidth: 0.5,
					});

					drawTextInCell(
						header.label,
						currentX,
						y,
						colWidths[index],
						TABLE_HEADER_HEIGHT,
						true,
						HEADER_TEXT_COLOR,
					);

					currentX += colWidths[index];
				});

				y -= TABLE_HEADER_HEIGHT;
			};

			drawHeader();

			let dataRowCount = 0;
			rows.forEach((row) => {
				const rowHeight = row.isImageRow ? TABLE_IMAGE_ROW_HEIGHT : TABLE_ROW_HEIGHT;

				if (y < MARGIN + BOTTOM_PADDING + rowHeight) {
					addNewPage();
					drawHeader();
				}

				if (!row.isImageRow && dataRowCount % 2 === 1) {
					page.drawRectangle({
						x: MARGIN,
						y: y - rowHeight,
						width: CONTENT_WIDTH,
						height: rowHeight,
						color: rgb(0.96, 0.96, 0.96),
					});
				}

				const normalizedCells = normalizeTableRow(row, headers.length);
				let currentX = MARGIN;

				normalizedCells.forEach((cell, colIndex) => {
					const cellWidth = colWidths[colIndex];
					page.drawRectangle({
						x: currentX,
						y: y - rowHeight,
						width: cellWidth,
						height: rowHeight,
						borderColor: BORDER_COLOR,
						borderWidth: 0.5,
					});

					if (row.isImageRow) {
						if (cell.imageUrl) {
							const asset = embeddedAssetMap.get(cell.imageUrl) || {
								placeholderText: "Image unavailable",
							};
							drawImageInCell(asset, currentX, y, cellWidth, rowHeight);
						}
					} else {
						drawTextInCell(cell.text || "", currentX, y, cellWidth, rowHeight);
					}

					currentX += cellWidth;
				});

				y -= rowHeight;
				if (!row.isImageRow) dataRowCount += 1;
			});

			y -= TABLE_BOTTOM_SPACING;
		};

		drawTable(
			"Product Information",
			[
				{ label: "Field", widthPct: 0.3 },
				{ label: "Value", widthPct: 0.7 },
			],
			infoRows,
			false,
		);

		drawTable(
			"Compliance Information",
			[
				{ label: "Standard", widthPct: 0.3 },
				{ label: "Description", widthPct: 0.7 },
			],
			complianceRows,
			true,
		);

		drawTable(
			"Label Components",
			[
				{ label: "Component #", widthPct: 0.1 },
				{ label: "Image", widthPct: 0.18 },
				{ label: "Description", widthPct: 0.28 },
				{ label: "Label Type", widthPct: 0.16 },
				{ label: "Dimensions", widthPct: 0.14 },
				{ label: "Component Type", widthPct: 0.14 },
			],
			labelComponentsRows,
			true,
		);

		drawTable(
			"Symbols",
			[
				{ label: "Name", widthPct: 0.25 },
				{ label: "Image", widthPct: 0.25 },
				{ label: "Text Present", widthPct: 0.25 },
				{ label: "Label Presence", widthPct: 0.25 },
			],
			symbolsRows,
			true,
		);

		drawTable(
			"Schematics",
			[
				{ label: "Name", widthPct: 0.2 },
				{ label: "Image", widthPct: 0.2 },
				{ label: "Label Presence", widthPct: 0.25 },
				{ label: "Description", widthPct: 0.35 },
			],
			schematicsRows,
			true,
		);

		drawTable(
			"Barcodes",
			[
				{ label: "Type", widthPct: 0.18 },
				{ label: "Image", widthPct: 0.18 },
				{ label: "Label Presence", widthPct: 0.22 },
				{ label: "Count", widthPct: 0.1 },
				{ label: "Description", widthPct: 0.32 },
			],
			barcodesRows,
			true,
		);

		drawTable(
			"Other Components",
			[
				{ label: "Name", widthPct: 0.2 },
				{ label: "Image", widthPct: 0.2 },
				{ label: "Label Presence", widthPct: 0.25 },
				{ label: "Description", widthPct: 0.35 },
			],
			otherComponentsRows,
			true,
		);

		if (productSpecsHeaders.length > 0) {
			drawTable("Product Specifications", productSpecsHeaders, productSpecsRows, true);
		}

		if (operationalHeaders.length > 0) {
			drawTable("Operational Parameters", operationalHeaders, operationalRows, true);
		}

		drawTable(
			"Label Tags",
			[
				{ label: "Name", widthPct: 0.18 },
				{ label: "Description", widthPct: 0.34 },
				{ label: "Type", widthPct: 0.18 },
				{ label: "Tagged Image", widthPct: 0.3 },
			],
			labelTagsRows,
			true,
		);

		const totalPages = pages.length;
		pages.forEach((p, index) => {
			const pageNumberText = `${index + 1} of ${totalPages}`;
			const topMetaY = PAGE_HEIGHT - MARGIN + 5;
			const pageNumberWidth = fontRegular.widthOfTextAtSize(pageNumberText, 10);
			const maxProductNameWidth = Math.max(120, PAGE_WIDTH - MARGIN * 2 - pageNumberWidth - 20);

			let headerProductName = productName;
			while (
				headerProductName.length > 3 &&
				fontRegular.widthOfTextAtSize(`${headerProductName}...`, 10) > maxProductNameWidth
			) {
				headerProductName = headerProductName.slice(0, -1);
			}
			if (headerProductName !== productName) headerProductName = `${headerProductName}...`;

			p.drawText(headerProductName, {
				x: MARGIN,
				y: topMetaY,
				size: 10,
				font: fontRegular,
				color: TOP_META_TEXT_COLOR,
			});

			p.drawText(pageNumberText, {
				x: PAGE_WIDTH - MARGIN - pageNumberWidth,
				y: topMetaY,
				size: 10,
				font: fontRegular,
				color: TOP_META_TEXT_COLOR,
			});

			p.drawLine({
				start: { x: MARGIN, y: PAGE_HEIGHT - MARGIN },
				end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - MARGIN },
				thickness: 0.5,
				color: rgb(0.85, 0.85, 0.85),
			});
		});

		const pdfBytes = await pdfDoc.save();
		return Buffer.from(pdfBytes);
	} catch (error) {
		logError("PDF export failed", error);
		return null;
	}
}
