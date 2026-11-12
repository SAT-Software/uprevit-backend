import { PDFDocument } from "pdf-lib";
import { Product } from "../models/product";
import transformUniverExcelData, { columnToLetter } from "./transformUniverExcelData";
import { logError } from "./logger";
import { createPresignedGetUrlMap, createStandardSymbolPresignedGetUrlMap } from "./s3-storage";
import { formatExportDate, listText, statusLabel, yesNo } from "./exportFormatting";
import { CONTENT_WIDTH, PdfCell, PdfColumn, PdfImageAsset, createPdfLayout } from "./pdfLayout";
import { WORKBOOK_TAB_SOURCES, type WorkbookTabTarget } from "./exportExcel";

const IMAGE_EMBED_CONCURRENCY = 5;
const MIN_WORKBOOK_COLUMN_WIDTH = 56;
const MAX_WORKBOOK_COLUMN_WIDTH = 260;
const COLUMN_TYPE_LABELS: Record<string, string> = { constant: "Constant", variable: "Variable", na: "N/A" };

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
	const explicitKey = toOptionalString(keyValue);
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
	const standardSymbolKeys = (productData.symbols_graphics?.data || [])
		.filter((item) => item.standard_symbol_id || item.standard_ref_number)
		.map((item) => item.key)
		.filter((key): key is string => Boolean(key));

	try {
		const maps = await Promise.all([
			createPresignedGetUrlMap(s3Keys, { workspaceId: productData.workspace_id }),
			createStandardSymbolPresignedGetUrlMap(standardSymbolKeys),
		]);
		return new Map(maps.flatMap((map) => [...map]));
	} catch (error) {
		logError("Failed to sign product image URLs for PDF export", error);
		return new Map<string, string>();
	}
};

const embedImageAsset = async (
	pdfDoc: PDFDocument,
	url: string,
): Promise<PdfImageAsset> => {
	if (isLikelyWebpUrl(url)) return { placeholderText: "Image format not supported" };

	try {
		const response = await fetch(url, { headers: { Connection: "close" } });
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
): Promise<Map<string, PdfImageAsset>> => {
	const uniqueUrls = [...new Set(urls.filter(Boolean))];
	const entries: Array<readonly [string, PdfImageAsset]> = [];

	for (let i = 0; i < uniqueUrls.length; i += IMAGE_EMBED_CONCURRENCY) {
		const chunk = uniqueUrls.slice(i, i + IMAGE_EMBED_CONCURRENCY);
		const chunkEntries = await Promise.all(
			chunk.map(async (url) => [url, await embedImageAsset(pdfDoc, url)] as const),
		);
		entries.push(...chunkEntries);
	}

	return new Map(entries);
};

const groupWorkbookColumns = (widths: number[]): number[][] => {
	const minWidths = widths.map((width) => Math.max(MIN_WORKBOOK_COLUMN_WIDTH, width * 0.65));
	const groups: number[][] = [];
	let current: number[] = [];
	let used = 0;
	minWidths.forEach((width, col) => {
		if (current.length && used + width > CONTENT_WIDTH) {
			groups.push(current);
			current = col > 0 ? [0] : [];
			used = current.reduce((sum, index) => sum + minWidths[index], 0);
		}
		current.push(col);
		used += width;
	});
	if (current.length) groups.push(current);
	return groups;
};

type PdfWorkbookSection = { title: string; sheets: ReturnType<typeof transformUniverExcelData>["sheets"] };

/**
 * Renders documentation workbook tabs as PDF sections.
 * @param {Awaited<ReturnType<typeof createPdfLayout>>} layout PDF layout
 * @param {PdfWorkbookSection[]} workbooks Tabs to render
 */
const renderWorkbookSections = (layout: Awaited<ReturnType<typeof createPdfLayout>>, workbooks: PdfWorkbookSection[]) => {
	workbooks.forEach(({ title, sheets }) => {
		layout.heading(title);
		if (!sheets.length) layout.table([{ label: "Data", weight: 1 }], [], { emptyText: `No ${title.toLowerCase()} added.` });
		sheets.forEach((sheet) => {
			const headerOffset = sheet.headerOffset ?? 1;
			const colCount = Math.max(1, ...sheet.data.map((row) => row.length));
			const widths = Array.from({ length: colCount }, (_, col) => Math.min(MAX_WORKBOOK_COLUMN_WIDTH, Math.max(MIN_WORKBOOK_COLUMN_WIDTH, (sheet.columnWidths?.[col] ?? 150) * 0.75)));
			const typeRow = headerOffset > 1 ? sheet.data[1] : undefined;
			const hasTypes = Boolean(typeRow?.some((value) => value !== null && value !== ""));
			const bodyRows = sheet.data.slice(headerOffset);
			const groups = groupWorkbookColumns(widths);
			groups.forEach((group, groupIndex) => {
				const start = group[groupIndex === 0 ? 0 : 1] ?? group[0];
				const caption = groups.length > 1 ? `Columns ${columnToLetter(start)}–${columnToLetter(group[group.length - 1])} of ${colCount}` : `${bodyRows.length} ${bodyRows.length === 1 ? "row" : "rows"}`;
				layout.subheading(sheet.name, caption);
				layout.table(
					group.map((col) => ({
						label: String(sheet.data[0]?.[col] ?? "") || `Column ${columnToLetter(col)}`,
						weight: widths[col],
						format: headerOffset > 0 ? sheet.formats?.[`0,${col}`] : undefined,
					})),
					bodyRows.map((row, index) => group.map((col) => ({ text: row[col] === null || row[col] === undefined ? "" : String(row[col]), format: sheet.formats?.[`${index + headerOffset},${col}`] }))),
					{
						subHeader: hasTypes ? group.map((col) => ({ text: COLUMN_TYPE_LABELS[String(typeRow?.[col] ?? "")] ?? String(typeRow?.[col] ?? ""), format: sheet.formats?.[`1,${col}`] })) : undefined,
						minRowHeights: bodyRows.map((_, index) => (sheet.rowHeights?.[index + headerOffset] ?? 0) * 0.75),
						emptyText: "No rows in this sheet.",
						hideHeader: headerOffset === 0,
					},
				);
			});
		});
	});
};

/**
 * Exports one documentation tab as a PDF.
 * @param {Product} product Product version
 * @param {WorkbookTabTarget} target Tab to export
 * @param {string} workspaceName Workspace name for the header
 * @return {Promise<Buffer | null>} PDF buffer, or null when generation fails
 */
export async function generateWorkbookTabPDFExport(product: Product, target: WorkbookTabTarget, workspaceName = "") {
	try {
		const layout = await createPdfLayout(product.product_name || "Untitled product", workspaceName);
		const { title, source } = WORKBOOK_TAB_SOURCES[target];
		renderWorkbookSections(layout, [{ title, sheets: transformUniverExcelData(source(product), true).sheets }]);
		return await layout.finish();
	} catch (error) {
		logError("Workbook tab PDF export failed", error, { target });
		return null;
	}
}

/**
 * Generates a PDF export of product data.
 * Creates a branded multi-page PDF document with a summary, product information,
 * compliance, languages, label components, symbols and graphics, workbook data and label tags.
 * @param {Product} productData - The product data to export
 * @param {string} workspaceName - Workspace name shown in the page header
 * @return {Promise<Buffer | null>} PDF buffer on success, null on failure
 */
export async function generateProductPDFExport(productData: Product, workspaceName = "") {
	try {
		const productName = productData.product_name || "Untitled product";
		const layout = await createPdfLayout(productName, workspaceName);
		const signedUrlMap = await loadSignedUrlMap(productData);
		const graphics = productData.symbols_graphics?.data || [];
		const byEntity = (entity: string) => graphics.filter((item) => item.entity === entity);
		const labelComponents = productData.label_components?.data || [];
		const labelTags = productData.label_tags?.data || [];
		const imageUrls = new Map<object, string | undefined>([
			...labelComponents.map((item) => [item, resolveImageUrl(item.image, item.key, signedUrlMap)] as const),
			...graphics.map((item) => [item, resolveImageUrl(item.image, item.key, signedUrlMap)] as const),
			...labelTags.map((item) => [item, getPreferredLabelTagImageUrl(item, signedUrlMap)] as const),
		]);
		const assets = await preloadEmbeddedAssets(layout.doc, [...imageUrls.values()].filter((url): url is string => Boolean(url)));
		const imageCell = (item: object): PdfCell => {
			const url = imageUrls.get(item);
			return url ? { image: assets.get(url) ?? { placeholderText: "Image unavailable" } } : { text: "No image", muted: true };
		};

		const workbooks = [
			{ title: "Product specifications", source: productData.product_data?.data },
			{ title: "Operational parameters", source: productData.operational_parameters?.data },
		].map(({ title, source }) => ({ title, sheets: transformUniverExcelData(source, true).sheets }));

		const info = productData.product_information?.data;
		const infoRows: Array<[string, unknown]> = [
			["Product name", productData.product_name],
			["Product description", productData.product_description],
			["Product plan number", productData.product_plan_number],
			["Status", statusLabel(productData.status)],
			["Version", productData.version],
			["Target date", formatExportDate(productData.target_date)],
			["Market geography", info?.market_geography],
			["Country of origin", info?.country_of_origin],
			["OEM / contract manufacturer", info?.oem_contract_manufacturer],
			["Commercial / clinical", info?.commercial_clinical],
			["Manufacturing location", info?.manufacturing_location],
			["Class of device", info?.class_of_device],
			["Basic UDI-DI", info?.basic_udi_di],
			...(productData.product_information?.custom_fields || []).map((field): [string, unknown] => [field.label, field.value]),
		];
		layout.heading("Product information");
		layout.table(
			[{ label: "Field", weight: 0.28 }, { label: "Value", weight: 0.72 }],
			infoRows.map(([label, value]) => [{ text: label, format: { bold: true } }, { text: value === undefined || value === null ? "" : String(value) }]),
		);

		const section = (title: string, columns: PdfColumn[], rows: PdfCell[][], emptyText: string) => {
			layout.heading(title, rows.length);
			layout.table(columns, rows, { emptyText });
		};

		section(
			"Compliance information",
			[{ label: "Standard", weight: 0.3 }, { label: "Description", weight: 0.7 }],
			(productData.compliance_information?.data || []).map((item) => [{ text: item.standard }, { text: item.standard_description }]),
			"No compliance standards added.",
		);

		section(
			"Languages",
			[{ label: "Code", weight: 0.14 }, { label: "Language", weight: 0.4 }, { label: "Country", weight: 0.46 }],
			(productData.languages_information?.data || []).map((item) => [{ text: item.code }, { text: item.name }, { text: item.country }]),
			"No languages added.",
		);

		section(
			"Label components",
			[
				{ label: "Image", weight: 0.16, imageHeight: 90 },
				{ label: "Component #", weight: 0.12 },
				{ label: "Description", weight: 0.24 },
				{ label: "Label type", weight: 0.13 },
				{ label: "Dimensions", weight: 0.12 },
				{ label: "Component type", weight: 0.12 },
				{ label: "Print direction", weight: 0.11 },
			],
			labelComponents.map((item) => [
				imageCell(item),
				{ text: item.component_number },
				{ text: item.component_description },
				{ text: listText(item.label_type) },
				{ text: item.dimensions },
				{ text: item.component_type },
				{ text: item.print_direction },
			]),
			"No label components added.",
		);

		section(
			"Symbols",
			[{ label: "Symbol", weight: 0.1, imageHeight: 40, align: "center" }, { label: "Name", weight: 0.35 }, { label: "Text present", weight: 0.15 }, { label: "Label presence", weight: 0.4 }],
			byEntity("Symbols").map((item) => [imageCell(item), { text: item.text }, { text: yesNo(item.text_present) }, { text: listText(item.label_presence) }]),
			"No symbols added.",
		);

		section(
			"Schematics",
			[{ label: "Image", weight: 0.18, imageHeight: 90 }, { label: "Name", weight: 0.22 }, { label: "Label presence", weight: 0.25 }, { label: "Description", weight: 0.35 }],
			byEntity("Schematics").map((item) => [imageCell(item), { text: item.text }, { text: listText(item.label_presence) }, { text: item.description }]),
			"No schematics added.",
		);

		section(
			"Barcodes",
			[{ label: "Image", weight: 0.18, imageHeight: 90 }, { label: "Type", weight: 0.2 }, { label: "Label presence", weight: 0.2 }, { label: "Count", weight: 0.08, align: "right" }, { label: "Description", weight: 0.34 }],
			byEntity("Barcodes").map((item) => [imageCell(item), { text: item.text }, { text: listText(item.label_presence) }, { text: String(item.count ?? 1) }, { text: item.description }]),
			"No barcodes added.",
		);

		section(
			"Other components",
			[{ label: "Image", weight: 0.18, imageHeight: 90 }, { label: "Name", weight: 0.22 }, { label: "Label presence", weight: 0.25 }, { label: "Description", weight: 0.35 }],
			byEntity("Other Components").map((item) => [imageCell(item), { text: item.text }, { text: listText(item.label_presence) }, { text: item.description }]),
			"No other components added.",
		);

		renderWorkbookSections(layout, workbooks);

		section(
			"Label tags",
			[{ label: "Image", weight: 0.18, imageHeight: 90 }, { label: "Name", weight: 0.22 }, { label: "Description", weight: 0.4 }, { label: "Type", weight: 0.2 }],
			labelTags.map((item) => [imageCell(item), { text: item.name }, { text: item.description }, { text: item.type }]),
			"No label tags added.",
		);

		return await layout.finish();
	} catch (error) {
		logError("PDF export failed", error);
		return null;
	}
}
