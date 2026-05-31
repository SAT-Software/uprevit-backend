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
const TABLE_BOTTOM_SPACING = 20;
const TOP_HEADER_HEIGHT = 26;
const BOTTOM_PADDING = 20;
const IMAGE_PADDING = 6;
const HEADER_FONT_SIZE = 10;
const HEADER_LINE_OFFSET = 4;
const IMAGE_ROW_SIDE_PADDING = 10;
const MIN_IMAGE_ROW_HEIGHT = 48;
const IMAGE_EMBED_CONCURRENCY = 5;
const AVAILABLE_PAGE_CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2 - TOP_HEADER_HEIGHT - BOTTOM_PADDING;
const MAX_IMAGE_ROW_HEIGHT = Math.floor(AVAILABLE_PAGE_CONTENT_HEIGHT * 0.65);

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
	imageUrl?: string;
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
		return await createPresignedGetUrlMap(s3Keys, { workspaceId: productData.workspace_id });
	} catch (error) {
		logError("Failed to sign product image URLs for PDF export", error);
		return new Map<string, string>();
	}
};

const appendDataAndImageRows = (rows: TableRow[], dataCells: string[], imageUrl?: string) => {
	rows.push({
		cells: dataCells.map((cell) => ({ text: cell })),
	});

	if (!imageUrl) return;

	rows.push({
		isImageRow: true,
		imageUrl,
		cells: [],
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
	if (isLikelyWebpUrl(url)) return { placeholderText: "Image format not supported" };

	try {
		const response = await fetch(url);
		if (!response.ok) return { placeholderText: "Image unavailable" };

		const bytes = new Uint8Array(await response.arrayBuffer());
		const format = getImageFormat(bytes, response.headers.get("content-type"), url);

		if (format === "webp") return { placeholderText: "Image format not supported" };
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
	const entries: Array<readonly [string, EmbeddedAsset]> = [];

	for (let i = 0; i < uniqueUrls.length; i += IMAGE_EMBED_CONCURRENCY) {
		const chunk = uniqueUrls.slice(i, i + IMAGE_EMBED_CONCURRENCY);
		const chunkEntries = await Promise.all(
			chunk.map(async (url) => [url, await embedImageAsset(pdfDoc, url)] as const),
		);
		entries.push(...chunkEntries);
	}

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
				["Class of Device", d.class_of_device || ""],
				["Basic UDI-DI", d.basic_udi_di || ""],
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

		const languageRows = toTextRows(
			(productData.languages_information?.data || []).map((item) => [
				item.code,
				item.name,
				item.country || "",
			]),
		);

		const labelComponentsRows: TableRow[] = [];
		(productData.label_components?.data || []).forEach((item) => {
			appendDataAndImageRows(
				labelComponentsRows,
				[
					toCleanString(item.component_number),
					toCleanString(item.component_description),
					Array.isArray(item.label_type) ? item.label_type.join(", ") : "",
					toCleanString(item.dimensions),
					toCleanString(item.component_type),
				],
				resolveImageUrl(item.image, item.key, signedUrlMap),
			);
		});

		const symbolsRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Symbols") || []).forEach((item) => {
			appendDataAndImageRows(
				symbolsRows,
				[
					toCleanString(item.text),
					item.text_present === undefined ? "" : item.text_present ? "Yes" : "No",
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
				],
				resolveImageUrl(item.image, item.key, signedUrlMap),
			);
		});

		const schematicsRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Schematics") || []).forEach((item) => {
			appendDataAndImageRows(
				schematicsRows,
				[
					toCleanString(item.text),
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					toCleanString(item.description),
				],
				resolveImageUrl(item.image, item.key, signedUrlMap),
			);
		});

		const barcodesRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Barcodes") || []).forEach((item) => {
			appendDataAndImageRows(
				barcodesRows,
				[
					toCleanString(item.text),
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					toCleanString(item.count ?? 1),
					toCleanString(item.description),
				],
				resolveImageUrl(item.image, item.key, signedUrlMap),
			);
		});

		const otherComponentsRows: TableRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Other Components") || []).forEach((item) => {
			appendDataAndImageRows(
				otherComponentsRows,
				[
					toCleanString(item.text),
					Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					toCleanString(item.description),
				],
				resolveImageUrl(item.image, item.key, signedUrlMap),
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
				],
				getPreferredLabelTagImageUrl(item, signedUrlMap),
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
		const allImageUrls = allRows.map((row) => row.imageUrl || "").filter(Boolean);
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

		const getImageRowHeight = (row: TableRow): number => {
			if (!row.isImageRow || !row.imageUrl) return TABLE_ROW_HEIGHT;
			const asset = embeddedAssetMap.get(row.imageUrl);
			if (!asset?.image) return MIN_IMAGE_ROW_HEIGHT;

			const availableWidth = Math.max(CONTENT_WIDTH - IMAGE_ROW_SIDE_PADDING * 2 - IMAGE_PADDING * 2, 1);
			const scaledHeight = (asset.image.height * availableWidth) / Math.max(asset.image.width, 1);
			const fullHeight = Math.ceil(scaledHeight + IMAGE_PADDING * 2);
			return Math.max(MIN_IMAGE_ROW_HEIGHT, Math.min(MAX_IMAGE_ROW_HEIGHT, fullHeight));
		};

		const drawImageInRow = (asset: EmbeddedAsset, rowTopY: number, rowHeight: number) => {
			const rowX = MARGIN;
			const rowBottomY = rowTopY - rowHeight;
			const contentX = rowX + IMAGE_ROW_SIDE_PADDING;
			const contentWidth = CONTENT_WIDTH - IMAGE_ROW_SIDE_PADDING * 2;

			if (!asset.image) {
				drawTextInCell(
					asset.placeholderText || "Image unavailable",
					contentX,
					rowTopY,
					contentWidth,
					rowHeight,
					false,
					PLACEHOLDER_TEXT_COLOR,
				);
				return;
			}

			const availableWidth = Math.max(contentWidth - IMAGE_PADDING * 2, 1);
			const availableHeight = Math.max(rowHeight - IMAGE_PADDING * 2, 1);
			const widthScale = availableWidth / Math.max(asset.image.width, 1);
			const heightScale = availableHeight / Math.max(asset.image.height, 1);
			const scale = Math.min(widthScale, heightScale);
			const drawWidth = asset.image.width * scale;
			const drawHeight = asset.image.height * scale;
			const drawX = contentX + (contentWidth - drawWidth) / 2;
			const drawY = rowBottomY + (rowHeight - drawHeight) / 2;

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
			for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
				const row = rows[rowIndex];
				const rowHeight = row.isImageRow ? getImageRowHeight(row) : TABLE_ROW_HEIGHT;

				const nextRow = rows[rowIndex + 1];
				const isDataRowWithImageBelow = !row.isImageRow && Boolean(nextRow?.isImageRow);
				const pairedImageHeight = isDataRowWithImageBelow ? getImageRowHeight(nextRow) : 0;
				const requiredHeight = rowHeight + pairedImageHeight;

				if (y < MARGIN + BOTTOM_PADDING + requiredHeight) {
					addNewPage();
					drawHeader();
				}

				if (row.isImageRow) {
					page.drawRectangle({
						x: MARGIN,
						y: y - rowHeight,
						width: CONTENT_WIDTH,
						height: rowHeight,
						borderColor: BORDER_COLOR,
						borderWidth: 0.5,
					});

					const asset = row.imageUrl
						? embeddedAssetMap.get(row.imageUrl) || { placeholderText: "Image unavailable" }
						: { placeholderText: "Image unavailable" };
					drawImageInRow(asset, y, rowHeight);
				} else {
					if (dataRowCount % 2 === 1) {
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

						drawTextInCell(cell.text || "", currentX, y, cellWidth, rowHeight);
						currentX += cellWidth;
					});
					dataRowCount += 1;
				}

				y -= rowHeight;
			}

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
			"Languages",
			[
				{ label: "Code", widthPct: 0.18 },
				{ label: "Language", widthPct: 0.38 },
				{ label: "Country", widthPct: 0.44 },
			],
			languageRows,
			true,
		);

		drawTable(
			"Label Components",
			[
				{ label: "Component #", widthPct: 0.14 },
				{ label: "Description", widthPct: 0.38 },
				{ label: "Label Type", widthPct: 0.18 },
				{ label: "Dimensions", widthPct: 0.14 },
				{ label: "Component Type", widthPct: 0.16 },
			],
			labelComponentsRows,
			true,
		);

		drawTable(
			"Symbols",
			[
				{ label: "Name", widthPct: 0.34 },
				{ label: "Text Present", widthPct: 0.22 },
				{ label: "Label Presence", widthPct: 0.44 },
			],
			symbolsRows,
			true,
		);

		drawTable(
			"Schematics",
			[
				{ label: "Name", widthPct: 0.22 },
				{ label: "Label Presence", widthPct: 0.28 },
				{ label: "Description", widthPct: 0.5 },
			],
			schematicsRows,
			true,
		);

		drawTable(
			"Barcodes",
			[
				{ label: "Type", widthPct: 0.24 },
				{ label: "Label Presence", widthPct: 0.24 },
				{ label: "Count", widthPct: 0.12 },
				{ label: "Description", widthPct: 0.4 },
			],
			barcodesRows,
			true,
		);

		drawTable(
			"Other Components",
			[
				{ label: "Name", widthPct: 0.24 },
				{ label: "Label Presence", widthPct: 0.26 },
				{ label: "Description", widthPct: 0.5 },
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
				{ label: "Name", widthPct: 0.22 },
				{ label: "Description", widthPct: 0.52 },
				{ label: "Type", widthPct: 0.26 },
			],
			labelTagsRows,
			true,
		);

		const totalPages = pages.length;
		pages.forEach((p, index) => {
			const pageNumberText = `${index + 1} of ${totalPages}`;
			const headerLineY = PAGE_HEIGHT - MARGIN - HEADER_LINE_OFFSET;
			const headerBandHeight = PAGE_HEIGHT - headerLineY;
			const topMetaY = headerLineY + (headerBandHeight - HEADER_FONT_SIZE) / 2;
			const pageNumberWidth = fontRegular.widthOfTextAtSize(pageNumberText, HEADER_FONT_SIZE);
			const maxProductNameWidth = Math.max(120, PAGE_WIDTH - MARGIN * 2 - pageNumberWidth - 20);

			let headerProductName = productName;
			while (
				headerProductName.length > 3 &&
				fontRegular.widthOfTextAtSize(`${headerProductName}...`, HEADER_FONT_SIZE) > maxProductNameWidth
			) {
				headerProductName = headerProductName.slice(0, -1);
			}
			if (headerProductName !== productName) headerProductName = `${headerProductName}...`;

			p.drawText(headerProductName, {
				x: MARGIN,
				y: topMetaY,
				size: HEADER_FONT_SIZE,
				font: fontRegular,
				color: TOP_META_TEXT_COLOR,
			});

			p.drawText(pageNumberText, {
				x: PAGE_WIDTH - MARGIN - pageNumberWidth,
				y: topMetaY,
				size: HEADER_FONT_SIZE,
				font: fontRegular,
				color: TOP_META_TEXT_COLOR,
			});

			p.drawLine({
				start: { x: MARGIN, y: headerLineY },
				end: { x: PAGE_WIDTH - MARGIN, y: headerLineY },
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
