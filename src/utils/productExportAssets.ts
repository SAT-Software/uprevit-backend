import { Product } from "../models/product";
import { logError } from "./logger";
import { createPresignedGetUrlMap, createStandardSymbolPresignedGetUrlMap } from "./s3-storage";

export type WorkbookTabTarget = "product_specifications" | "operational_parameters";

export const WORKBOOK_TAB_SOURCES: Record<WorkbookTabTarget, { title: string; source: (product: Product) => unknown }> = {
	product_specifications: { title: "Product Specifications", source: (product) => product.product_data?.data },
	operational_parameters: { title: "Operational Parameters", source: (product) => product.operational_parameters?.data },
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

export const isLikelyWebpUrl = (url: string): boolean => {
	const normalized = url.toLowerCase();
	if (normalized.startsWith("data:image/webp")) return true;

	try {
		return new URL(url).pathname.toLowerCase().endsWith(".webp");
	} catch {
		return normalized.split("?")[0].split("#")[0].endsWith(".webp");
	}
};

export const isWebpBytes = (bytes: Uint8Array): boolean => {
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

export const resolveImageUrl = (
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

export const getPreferredLabelTagImageUrl = (
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

/**
 * Signs every image the product's exports may embed.
 * @param {Product} productData Product version
 * @return {Promise<Map<string, string>>} S3 key to signed URL; empty when signing fails
 */
export const loadSignedUrlMap = async (productData: Product): Promise<Map<string, string>> => {
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
		logError("Failed to sign product image URLs for export", error);
		return new Map<string, string>();
	}
};
