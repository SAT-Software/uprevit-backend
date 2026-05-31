import { Product } from "../models/product";
import { applyStandardStyling } from "./exportExcelStyling";
import transformUniverExcelData from "./transformUniverExcelData";
import { logError } from "./logger";
import { createPresignedGetUrlMap } from "./s3-storage";

require("core-js/modules/es.promise");
require("core-js/modules/es.string.includes");
require("core-js/modules/es.object.assign");
require("core-js/modules/es.object.keys");
require("core-js/modules/es.symbol");
require("core-js/modules/es.symbol.async-iterator");
require("regenerator-runtime/runtime");

const ExcelJS = require("exceljs/dist/es5");

const IMAGE_FETCH_CONCURRENCY = 5;
const IMAGE_PLACEHOLDER_TEXT = "Image format not supported";
const IMAGE_ROW_HORIZONTAL_PADDING_PX = 16;
const IMAGE_ROW_VERTICAL_PADDING_PX = 10;
const PLACEHOLDER_ROW_HEIGHT_POINTS = 36;
const DEFAULT_COLUMN_WIDTH = 8.43;

type SheetDataRow = Record<string, string | number>;

type SheetImageRow = {
	rowNumber: number;
	startColumnIndex: number;
	endColumnIndex: number;
	imageUrl?: string;
};

type WorkbookImageAsset = {
	imageId?: number;
	placeholderText?: string;
	widthPx?: number;
	heightPx?: number;
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
		logError("Failed to sign product image URLs for Excel export", error);
		return new Map<string, string>();
	}
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

const detectImageExtension = (
	bytes: Uint8Array,
	contentType: string | null,
	url: string,
): "png" | "jpeg" | "webp" | null => {
	const normalizedContentType = (contentType || "").toLowerCase();

	if (normalizedContentType.includes("image/webp") || isLikelyWebpUrl(url) || isWebpBytes(bytes)) return "webp";
	if (normalizedContentType.includes("image/png")) return "png";
	if (normalizedContentType.includes("image/jpeg") || normalizedContentType.includes("image/jpg")) return "jpeg";

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

	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";

	return null;
};

const getPngDimensions = (bytes: Uint8Array): { widthPx: number; heightPx: number } | null => {
	if (
		bytes.length < 24 ||
		bytes[0] !== 0x89 ||
		bytes[1] !== 0x50 ||
		bytes[2] !== 0x4e ||
		bytes[3] !== 0x47
	) {
		return null;
	}

	const widthPx =
		(bytes[16] << 24) |
		(bytes[17] << 16) |
		(bytes[18] << 8) |
		bytes[19];
	const heightPx =
		(bytes[20] << 24) |
		(bytes[21] << 16) |
		(bytes[22] << 8) |
		bytes[23];

	if (widthPx <= 0 || heightPx <= 0) return null;
	return { widthPx, heightPx };
};

const getJpegDimensions = (bytes: Uint8Array): { widthPx: number; heightPx: number } | null => {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}

		let marker = bytes[offset + 1];
		offset += 2;

		while (marker === 0xff && offset < bytes.length) {
			marker = bytes[offset];
			offset += 1;
		}

		if (marker === 0xd8 || marker === 0xd9) continue;
		if (marker === 0xda) break;
		if (offset + 1 >= bytes.length) break;

		const segmentLength = (bytes[offset] << 8) + bytes[offset + 1];
		if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

		const isStartOfFrame =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);

		if (isStartOfFrame && segmentLength >= 7) {
			const heightPx = (bytes[offset + 3] << 8) + bytes[offset + 4];
			const widthPx = (bytes[offset + 5] << 8) + bytes[offset + 6];
			if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx };
			return null;
		}

		offset += segmentLength;
	}

	return null;
};

const getImageDimensions = (
	bytes: Uint8Array,
	extension: "png" | "jpeg",
): { widthPx: number; heightPx: number } | null => {
	if (extension === "png") return getPngDimensions(bytes);
	return getJpegDimensions(bytes);
};

const fetchWorkbookImageAsset = async (workbook: any, url: string): Promise<WorkbookImageAsset> => {
	if (isLikelyWebpUrl(url)) return { placeholderText: IMAGE_PLACEHOLDER_TEXT };

	try {
		const response = await fetch(url);
		if (!response.ok) return { placeholderText: "Image unavailable" };

		const bytes = new Uint8Array(await response.arrayBuffer());
		const extension = detectImageExtension(bytes, response.headers.get("content-type"), url);

		if (extension === "webp") return { placeholderText: IMAGE_PLACEHOLDER_TEXT };
		if (!extension) return { placeholderText: "Unsupported image" };

		const dimensions = getImageDimensions(bytes, extension);
		if (!dimensions) return { placeholderText: "Unsupported image" };

		const imageId = workbook.addImage({
			extension,
			buffer: Buffer.from(bytes),
		});

		return {
			imageId,
			widthPx: dimensions.widthPx,
			heightPx: dimensions.heightPx,
		};
	} catch {
		return { placeholderText: "Image unavailable" };
	}
};

const preloadWorkbookImageAssets = async (
	workbook: any,
	urls: string[],
): Promise<Map<string, WorkbookImageAsset>> => {
	const uniqueUrls = [...new Set(urls.filter((url): url is string => typeof url === "string" && url.length > 0))];
	const entries: Array<readonly [string, WorkbookImageAsset]> = [];

	for (let i = 0; i < uniqueUrls.length; i += IMAGE_FETCH_CONCURRENCY) {
		const chunk = uniqueUrls.slice(i, i + IMAGE_FETCH_CONCURRENCY);
		const chunkEntries = await Promise.all(
			chunk.map(async (url) => [url, await fetchWorkbookImageAsset(workbook, url)] as const),
		);
		entries.push(...chunkEntries);
	}

	return new Map(entries);
};

const createEmptyRow = (rowData: SheetDataRow): SheetDataRow => {
	const emptyRow: SheetDataRow = {};
	Object.keys(rowData).forEach((key) => {
		emptyRow[key] = "";
	});
	return emptyRow;
};

const appendSheetDataAndImageRows = ({
	rows,
	imageRows,
	rowData,
	imageUrl,
	columnCount,
}: {
	rows: SheetDataRow[];
	imageRows: SheetImageRow[];
	rowData: SheetDataRow;
	imageUrl?: string;
	columnCount: number;
}) => {
	rows.push(rowData);

	if (!imageUrl) return;

	const imageRowNumber = rows.length + 2;
	rows.push(createEmptyRow(rowData));
	imageRows.push({
		rowNumber: imageRowNumber,
		startColumnIndex: 1,
		endColumnIndex: columnCount,
		imageUrl,
	});
};

const getMergeRange = (worksheet: any, imageRow: SheetImageRow): string => {
	const startColumnLetter = worksheet.getColumn(imageRow.startColumnIndex).letter;
	const endColumnLetter = worksheet.getColumn(imageRow.endColumnIndex).letter;
	return `${startColumnLetter}${imageRow.rowNumber}:${endColumnLetter}${imageRow.rowNumber}`;
};

const mergeSheetImageRows = (worksheet: any, imageRows: SheetImageRow[]) => {
	imageRows.forEach((imageRow) => {
		worksheet.mergeCells(getMergeRange(worksheet, imageRow));
	});
};

const columnWidthToPixels = (width: number | undefined): number => {
	const normalizedWidth = typeof width === "number" && width > 0 ? width : DEFAULT_COLUMN_WIDTH;
	return Math.floor(normalizedWidth * 7 + 5);
};

const pixelsToRowHeightPoints = (pixels: number): number => {
	return pixels * 0.75;
};

const getImageRowWidthPx = (worksheet: any, imageRow: SheetImageRow): number => {
	let totalWidth = 0;
	for (let columnIndex = imageRow.startColumnIndex; columnIndex <= imageRow.endColumnIndex; columnIndex += 1) {
		totalWidth += columnWidthToPixels(worksheet.getColumn(columnIndex).width);
	}
	return totalWidth;
};

const attachSheetImages = ({
	worksheet,
	imageRows,
	assetMap,
}: {
	worksheet: any;
	imageRows: SheetImageRow[];
	assetMap: Map<string, WorkbookImageAsset>;
}) => {
	for (const imageRow of imageRows) {
		const row = worksheet.getRow(imageRow.rowNumber);
		const cell = row.getCell(imageRow.startColumnIndex);
		const asset = imageRow.imageUrl ? assetMap.get(imageRow.imageUrl) : undefined;

		if (
			asset?.imageId === undefined ||
			!asset.widthPx ||
			!asset.heightPx
		) {
			cell.value = asset?.placeholderText || "";
			cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
			row.height = PLACEHOLDER_ROW_HEIGHT_POINTS;
			continue;
		}

		const totalWidthPx = getImageRowWidthPx(worksheet, imageRow);
		const availableWidthPx = Math.max(totalWidthPx - IMAGE_ROW_HORIZONTAL_PADDING_PX * 2, 1);
		const drawWidthPx = availableWidthPx;
		const drawHeightPx = Math.max(
			(asset.heightPx * drawWidthPx) / Math.max(asset.widthPx, 1),
			1,
		);
		const rowHeightPx = drawHeightPx + IMAGE_ROW_VERTICAL_PADDING_PX * 2;
		const firstColumnWidthPx = Math.max(
			columnWidthToPixels(worksheet.getColumn(imageRow.startColumnIndex).width),
			1,
		);
		const rowHeightForAnchorPx = Math.max(rowHeightPx, 1);

		cell.value = "";
		row.height = pixelsToRowHeightPoints(rowHeightPx);
		worksheet.addImage(asset.imageId, {
			tl: {
				col:
					imageRow.startColumnIndex - 1 +
					IMAGE_ROW_HORIZONTAL_PADDING_PX / firstColumnWidthPx,
				row:
					imageRow.rowNumber - 1 +
					IMAGE_ROW_VERTICAL_PADDING_PX / rowHeightForAnchorPx,
			},
			ext: {
				width: drawWidthPx,
				height: drawHeightPx,
			},
			editAs: "oneCell",
		});
	}
};

/**
 * Generates an Excel export of product data.
 * Creates a multi-sheet workbook with separate sheets for product information,
 * compliance, label components, symbols, barcodes, specifications, and more.
 * @param {Product} productData - The product data to export
 * @return {Promise<Buffer | null>} Excel buffer on success, null on failure
 */
export async function generateProductExcelExport(productData: Product) {
	try {
		const workbook = new ExcelJS.Workbook();
		workbook.creator = "Uprevit";
		workbook.created = new Date();

		const signedUrlMap = await loadSignedUrlMap(productData);

		const productInfoSheet = workbook.addWorksheet("Product Info", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		productInfoSheet.columns = [
			{ header: "Field", key: "field", width: 30 },
			{ header: "Value", key: "value", width: 50 },
		];

		const infoData = productData.product_information?.data;
		const infoRows: Array<{ field: string; value: string }> = [
			{ field: "Product Name", value: productData.product_name || "" },
			{ field: "Product Description", value: productData.product_description || "" },
			{ field: "Product Plan Number", value: productData.product_plan_number || "" },
		];

		if (infoData) {
			infoRows.push(
				{ field: "Market Geography", value: infoData.market_geography || "" },
				{ field: "Country of Origin", value: infoData.country_of_origin || "" },
				{ field: "OEM Contract Manufacturer", value: infoData.oem_contract_manufacturer || "" },
				{ field: "Commercial/Clinical", value: infoData.commercial_clinical || "" },
				{ field: "Manufacturing Location", value: infoData.manufacturing_location || "" },
				{ field: "Class of Device", value: infoData.class_of_device || "" },
				{ field: "Basic UDI-DI", value: infoData.basic_udi_di || "" },
			);
		}

		(productData.product_information?.custom_fields || []).forEach((field) => {
			infoRows.push({ field: field.label, value: field.value });
		});

		productInfoSheet.addRows(infoRows);
		applyStandardStyling(productInfoSheet);
		productInfoSheet.getRow(1).font = { bold: true };

		const complianceInfoSheet = workbook.addWorksheet("Compliance Info", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		complianceInfoSheet.columns = [
			{ header: "Standard", key: "standard", width: 30 },
			{ header: "Standard Description", key: "standard_description", width: 50 },
		];

		const complianceRows = (productData.compliance_information?.data || []).map((item) => ({
			standard: item.standard || "",
			standard_description: item.standard_description || "",
		}));

		complianceInfoSheet.addRows(complianceRows);
		applyStandardStyling(complianceInfoSheet);
		complianceInfoSheet.getRow(1).font = { bold: true };

		const languagesInfoSheet = workbook.addWorksheet("Languages", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		languagesInfoSheet.columns = [
			{ header: "Code", key: "code", width: 12 },
			{ header: "Language", key: "name", width: 28 },
			{ header: "Country", key: "country", width: 24 },
		];

		const languageRows = (productData.languages_information?.data || []).map((item) => ({
			code: item.code || "",
			name: item.name || "",
			country: item.country || "",
		}));

		languagesInfoSheet.addRows(languageRows);
		applyStandardStyling(languagesInfoSheet);
		languagesInfoSheet.getRow(1).font = { bold: true };

		const labelComponentsSheet = workbook.addWorksheet("Label Components", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		labelComponentsSheet.columns = [
			{ header: "Component Number", key: "component_number", width: 30 },
			{ header: "Component Description", key: "component_description", width: 50 },
			{ header: "Label Type", key: "label_type", width: 30 },
			{ header: "Dimensions", key: "dimensions", width: 30 },
			{ header: "Component Type", key: "component_type", width: 30 },
		];

		const labelComponentsRows: SheetDataRow[] = [];
		const labelComponentsImageRows: SheetImageRow[] = [];
		(productData.label_components?.data || []).forEach((item) => {
			appendSheetDataAndImageRows({
				rows: labelComponentsRows,
				imageRows: labelComponentsImageRows,
				rowData: {
					component_number: item.component_number || "",
					component_description: item.component_description || "",
					label_type: Array.isArray(item.label_type) ? item.label_type.join(", ") : "",
					dimensions: item.dimensions || "",
					component_type: item.component_type || "",
				},
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
				columnCount: labelComponentsSheet.columns.length,
			});
		});

		labelComponentsSheet.addRows(labelComponentsRows);
		applyStandardStyling(labelComponentsSheet);
		mergeSheetImageRows(labelComponentsSheet, labelComponentsImageRows);
		labelComponentsSheet.getRow(1).font = { bold: true };

		const symbolsSheet = workbook.addWorksheet("Symbols", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		symbolsSheet.columns = [
			{ header: "Name", key: "text", width: 30 },
			{ header: "Text Present", key: "text_present", width: 20 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
		];

		const symbolsRows: SheetDataRow[] = [];
		const symbolsImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Symbols") || []).forEach((item) => {
			appendSheetDataAndImageRows({
				rows: symbolsRows,
				imageRows: symbolsImageRows,
				rowData: {
					text: item.text || "",
					text_present: item.text_present === undefined ? "" : item.text_present ? "Yes" : "No",
					label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
				},
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
				columnCount: symbolsSheet.columns.length,
			});
		});

		symbolsSheet.addRows(symbolsRows);
		applyStandardStyling(symbolsSheet);
		mergeSheetImageRows(symbolsSheet, symbolsImageRows);
		symbolsSheet.getRow(1).font = { bold: true };

		const schematicsSheet = workbook.addWorksheet("Schematics", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		schematicsSheet.columns = [
			{ header: "Name", key: "text", width: 30 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
			{ header: "Description", key: "description", width: 50 },
		];

		const schematicsRows: SheetDataRow[] = [];
		const schematicsImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Schematics") || []).forEach((item) => {
			appendSheetDataAndImageRows({
				rows: schematicsRows,
				imageRows: schematicsImageRows,
				rowData: {
					text: item.text || "",
					label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					description: item.description || "",
				},
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
				columnCount: schematicsSheet.columns.length,
			});
		});

		schematicsSheet.addRows(schematicsRows);
		applyStandardStyling(schematicsSheet);
		mergeSheetImageRows(schematicsSheet, schematicsImageRows);
		schematicsSheet.getRow(1).font = { bold: true };

		const barcodesSheet = workbook.addWorksheet("Barcodes", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		barcodesSheet.columns = [
			{ header: "Type", key: "text", width: 30 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
			{ header: "Count", key: "count", width: 20 },
			{ header: "Description", key: "description", width: 50 },
		];

		const barcodesRows: SheetDataRow[] = [];
		const barcodesImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Barcodes") || []).forEach((item) => {
			appendSheetDataAndImageRows({
				rows: barcodesRows,
				imageRows: barcodesImageRows,
				rowData: {
					text: item.text || "",
					label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					count: item.count ?? 1,
					description: item.description || "",
				},
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
				columnCount: barcodesSheet.columns.length,
			});
		});

		barcodesSheet.addRows(barcodesRows);
		applyStandardStyling(barcodesSheet);
		mergeSheetImageRows(barcodesSheet, barcodesImageRows);
		barcodesSheet.getRow(1).font = { bold: true };

		const otherComponentsSheet = workbook.addWorksheet("Other Components", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		otherComponentsSheet.columns = [
			{ header: "Name", key: "text", width: 30 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
			{ header: "Description", key: "description", width: 50 },
		];

		const otherComponentsRows: SheetDataRow[] = [];
		const otherComponentsImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Other Components") || []).forEach((item) => {
			appendSheetDataAndImageRows({
				rows: otherComponentsRows,
				imageRows: otherComponentsImageRows,
				rowData: {
					text: item.text || "",
					label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(", ") : "",
					description: item.description || "",
				},
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
				columnCount: otherComponentsSheet.columns.length,
			});
		});

		otherComponentsSheet.addRows(otherComponentsRows);
		applyStandardStyling(otherComponentsSheet);
		mergeSheetImageRows(otherComponentsSheet, otherComponentsImageRows);
		otherComponentsSheet.getRow(1).font = { bold: true };

		const productDataSheet = workbook.addWorksheet("Product Specifications", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		const productDataTransformed = transformUniverExcelData(productData.product_data?.data);
		if (productDataTransformed.sheets.length > 0) {
			const sheetData = productDataTransformed.sheets[0];
			sheetData.data.forEach((row) => productDataSheet.addRow(row));
			sheetData.merges.forEach((merge) => productDataSheet.mergeCells(merge));
		}
		applyStandardStyling(productDataSheet);

		const operationalDataSheet = workbook.addWorksheet("Operational Data", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		const operationalDataTransformed = transformUniverExcelData(productData.operational_parameters?.data);
		if (operationalDataTransformed.sheets.length > 0) {
			const sheetData = operationalDataTransformed.sheets[0];
			sheetData.data.forEach((row) => operationalDataSheet.addRow(row));
			sheetData.merges.forEach((merge) => operationalDataSheet.mergeCells(merge));
		}
		applyStandardStyling(operationalDataSheet);

		const labelTagsSheet = workbook.addWorksheet("Label Tags", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		labelTagsSheet.columns = [
			{ header: "Name", key: "name", width: 30 },
			{ header: "Description", key: "description", width: 50 },
			{ header: "Type", key: "type", width: 30 },
		];

		const labelTagsRows: SheetDataRow[] = [];
		const labelTagsImageRows: SheetImageRow[] = [];
		(productData.label_tags?.data || []).forEach((item) => {
			appendSheetDataAndImageRows({
				rows: labelTagsRows,
				imageRows: labelTagsImageRows,
				rowData: {
					name: item.name || "",
					description: item.description || "",
					type: item.type || "",
				},
				imageUrl: getPreferredLabelTagImageUrl(item, signedUrlMap),
				columnCount: labelTagsSheet.columns.length,
			});
		});

		labelTagsSheet.addRows(labelTagsRows);
		applyStandardStyling(labelTagsSheet);
		mergeSheetImageRows(labelTagsSheet, labelTagsImageRows);
		labelTagsSheet.getRow(1).font = { bold: true };

		const imageUrls = [
			...labelComponentsImageRows,
			...symbolsImageRows,
			...schematicsImageRows,
			...barcodesImageRows,
			...otherComponentsImageRows,
			...labelTagsImageRows,
		]
			.map((row) => row.imageUrl)
			.filter((url): url is string => Boolean(url));

		const workbookImageAssets = await preloadWorkbookImageAssets(workbook, imageUrls);

		attachSheetImages({
			worksheet: labelComponentsSheet,
			imageRows: labelComponentsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			worksheet: symbolsSheet,
			imageRows: symbolsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			worksheet: schematicsSheet,
			imageRows: schematicsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			worksheet: barcodesSheet,
			imageRows: barcodesImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			worksheet: otherComponentsSheet,
			imageRows: otherComponentsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			worksheet: labelTagsSheet,
			imageRows: labelTagsImageRows,
			assetMap: workbookImageAssets,
		});

		const buffer = await workbook.xlsx.writeBuffer();
		return Buffer.from(buffer);
	} catch (error) {
		logError("Excel export failed", error);
		return null;
	}
}
