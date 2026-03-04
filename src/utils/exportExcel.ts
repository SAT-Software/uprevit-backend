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
const IMAGE_ROW_HEIGHT = 88;
const IMAGE_PLACEHOLDER_TEXT = "Image format not supported";

type SheetImageRow = {
	rowNumber: number;
	imageColumnIndex: number;
	imageUrl?: string;
};

type WorkbookImageAsset = {
	imageId?: number;
	placeholderText?: string;
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
		return await createPresignedGetUrlMap(s3Keys);
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

const fetchWorkbookImageAsset = async (workbook: any, url: string): Promise<WorkbookImageAsset> => {
	if (isLikelyWebpUrl(url)) return { placeholderText: IMAGE_PLACEHOLDER_TEXT };

	try {
		const response = await fetch(url);
		if (!response.ok) return { placeholderText: "Image unavailable" };

		const bytes = new Uint8Array(await response.arrayBuffer());
		const extension = detectImageExtension(bytes, response.headers.get("content-type"), url);

		if (extension === "webp") return { placeholderText: IMAGE_PLACEHOLDER_TEXT };
		if (!extension) return { placeholderText: "Unsupported image" };

		const imageId = workbook.addImage({
			extension,
			buffer: Buffer.from(bytes),
		});

		return { imageId };
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

const attachSheetImages = ({
	workbook,
	worksheet,
	imageRows,
	assetMap,
}: {
	workbook: any;
	worksheet: any;
	imageRows: SheetImageRow[];
	assetMap: Map<string, WorkbookImageAsset>;
}) => {
	for (const imageRow of imageRows) {
		const cell = worksheet.getRow(imageRow.rowNumber).getCell(imageRow.imageColumnIndex);
		const asset = imageRow.imageUrl ? assetMap.get(imageRow.imageUrl) : undefined;

		if (!asset?.imageId) {
			cell.value = asset?.placeholderText || "";
			cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
			continue;
		}

		cell.value = "";
		worksheet.getRow(imageRow.rowNumber).height = IMAGE_ROW_HEIGHT;
		workbook.getWorksheet(worksheet.name).addImage(asset.imageId, {
			tl: { col: imageRow.imageColumnIndex - 1 + 0.1, row: imageRow.rowNumber - 1 + 0.1 },
			br: { col: imageRow.imageColumnIndex - 0.1, row: imageRow.rowNumber - 0.1 },
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

		const labelComponentsSheet = workbook.addWorksheet("Label Components", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		labelComponentsSheet.columns = [
			{ header: "Component Number", key: "component_number", width: 30 },
			{ header: "Image", key: "image", width: 28 },
			{ header: "Component Description", key: "component_description", width: 50 },
			{ header: "Label Type", key: "label_type", width: 30 },
			{ header: "Dimensions", key: "dimensions", width: 30 },
			{ header: "Component Type", key: "component_type", width: 30 },
		];

		const labelComponentsRows: Array<Record<string, string>> = [];
		const labelComponentsImageRows: SheetImageRow[] = [];
		(productData.label_components?.data || []).forEach((item, index) => {
			labelComponentsRows.push({
				component_number: item.component_number || "",
				image: "",
				component_description: item.component_description || "",
				label_type: Array.isArray(item.label_type) ? item.label_type.join(", ") : "",
				dimensions: item.dimensions || "",
				component_type: item.component_type || "",
			});

			labelComponentsImageRows.push({
				rowNumber: index + 2,
				imageColumnIndex: 2,
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
			});
		});

		labelComponentsSheet.addRows(labelComponentsRows);
		applyStandardStyling(labelComponentsSheet);
		labelComponentsSheet.getRow(1).font = { bold: true };

		const symbolsSheet = workbook.addWorksheet("Symbols", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		symbolsSheet.columns = [
			{ header: "Name", key: "text", width: 30 },
			{ header: "Image", key: "image", width: 28 },
			{ header: "Text Present", key: "text_present", width: 20 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
		];

		const symbolsRows: Array<Record<string, string>> = [];
		const symbolsImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Symbols") || []).forEach((item, index) => {
			symbolsRows.push({
				text: item.text || "",
				image: "",
				text_present: item.text_present === undefined ? "" : item.text_present ? "Yes" : "No",
				label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(",") : "",
			});

			symbolsImageRows.push({
				rowNumber: index + 2,
				imageColumnIndex: 2,
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
			});
		});

		symbolsSheet.addRows(symbolsRows);
		applyStandardStyling(symbolsSheet);
		symbolsSheet.getRow(1).font = { bold: true };

		const schematicsSheet = workbook.addWorksheet("Schematics", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		schematicsSheet.columns = [
			{ header: "Name", key: "text", width: 30 },
			{ header: "Image", key: "image", width: 28 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
			{ header: "Description", key: "description", width: 50 },
		];

		const schematicsRows: Array<Record<string, string>> = [];
		const schematicsImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Schematics") || []).forEach((item, index) => {
			schematicsRows.push({
				text: item.text || "",
				image: "",
				label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(",") : "",
				description: item.description || "",
			});

			schematicsImageRows.push({
				rowNumber: index + 2,
				imageColumnIndex: 2,
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
			});
		});

		schematicsSheet.addRows(schematicsRows);
		applyStandardStyling(schematicsSheet);
		schematicsSheet.getRow(1).font = { bold: true };

		const barcodesSheet = workbook.addWorksheet("Barcodes", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		barcodesSheet.columns = [
			{ header: "Type", key: "text", width: 30 },
			{ header: "Image", key: "image", width: 28 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
			{ header: "Count", key: "count", width: 20 },
			{ header: "Description", key: "description", width: 50 },
		];

		const barcodesRows: Array<Record<string, string | number>> = [];
		const barcodesImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Barcodes") || []).forEach((item, index) => {
			barcodesRows.push({
				text: item.text || "",
				image: "",
				label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(",") : "",
				count: item.count || 1,
				description: item.description || "",
			});

			barcodesImageRows.push({
				rowNumber: index + 2,
				imageColumnIndex: 2,
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
			});
		});

		barcodesSheet.addRows(barcodesRows);
		applyStandardStyling(barcodesSheet);
		barcodesSheet.getRow(1).font = { bold: true };

		const otherComponentsSheet = workbook.addWorksheet("Other Components", {
			pageSetup: { paperSize: 9, orientation: "landscape" },
		});

		otherComponentsSheet.columns = [
			{ header: "Name", key: "text", width: 30 },
			{ header: "Image", key: "image", width: 28 },
			{ header: "Label Presence", key: "label_presence", width: 50 },
			{ header: "Description", key: "description", width: 50 },
		];

		const otherComponentsRows: Array<Record<string, string>> = [];
		const otherComponentsImageRows: SheetImageRow[] = [];
		(productData.symbols_graphics?.data?.filter((item) => item.entity === "Other Components") || []).forEach((item, index) => {
			otherComponentsRows.push({
				text: item.text || "",
				image: "",
				label_presence: Array.isArray(item.label_presence) ? item.label_presence.join(",") : "",
				description: item.description || "",
			});

			otherComponentsImageRows.push({
				rowNumber: index + 2,
				imageColumnIndex: 2,
				imageUrl: resolveImageUrl(item.image, item.key, signedUrlMap),
			});
		});

		otherComponentsSheet.addRows(otherComponentsRows);
		applyStandardStyling(otherComponentsSheet);
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
			{ header: "Image", key: "image", width: 28 },
			{ header: "Tagged Image", key: "tagged_image", width: 28 },
		];

		const labelTagsRows: Array<Record<string, string>> = [];
		const labelTagsImageRows: SheetImageRow[] = [];
		(productData.label_tags?.data || []).forEach((item, index) => {
			labelTagsRows.push({
				name: item.name || "",
				description: item.description || "",
				type: item.type || "",
				image: "",
				tagged_image: "",
			});

			const preferredImageUrl = getPreferredLabelTagImageUrl(item, signedUrlMap);
			labelTagsImageRows.push({
				rowNumber: index + 2,
				imageColumnIndex: 4,
				imageUrl: preferredImageUrl,
			});
		});

		labelTagsSheet.addRows(labelTagsRows);
		applyStandardStyling(labelTagsSheet);
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
			workbook,
			worksheet: labelComponentsSheet,
			imageRows: labelComponentsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			workbook,
			worksheet: symbolsSheet,
			imageRows: symbolsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			workbook,
			worksheet: schematicsSheet,
			imageRows: schematicsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			workbook,
			worksheet: barcodesSheet,
			imageRows: barcodesImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			workbook,
			worksheet: otherComponentsSheet,
			imageRows: otherComponentsImageRows,
			assetMap: workbookImageAssets,
		});

		attachSheetImages({
			workbook,
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
