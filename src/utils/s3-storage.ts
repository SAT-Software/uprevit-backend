import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const region = process.env.AWS_REGION;
const uploadsBucket = process.env.UPLOADS_BUCKET;
const exportsBucket = process.env.EXPORTS_BUCKET;
const standardSymbolsBucket = process.env.STANDARD_SYMBOLS_BUCKET;
const documentationFilesBucket = process.env.DOCUMENTATION_FILES_BUCKET;

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const DOCS_FILE_URL_EXPIRES_IN_SECONDS = parsePositiveInteger(
	process.env.DOCS_VIDEO_URL_EXPIRES_IN_SECONDS,
	900,
);

if (!region) throw new Error("Missing required environment variable: AWS_REGION");
if (!uploadsBucket) throw new Error("Missing required environment variable: UPLOADS_BUCKET");
if (!exportsBucket) throw new Error("Missing required environment variable: EXPORTS_BUCKET");

const VIEW_URL_EXPIRES_IN_SECONDS = parsePositiveInteger(process.env.S3_VIEW_URL_EXPIRES_IN_SECONDS, 43200);
const SIGNING_CONCURRENCY = parsePositiveInteger(process.env.S3_SIGNING_CONCURRENCY, 25);

export const client = new S3Client({ region });

export type UploadScope = "workspace-assets" | "product-assets" | "source-files";

type CreatePresignedUploadOptions = {
	workspaceId?: string;
	productId?: string;
	uploadScope?: UploadScope;
	pendingOwnerId?: string;
};

const sanitizeFilename = (filename: string): string => filename.replace(/[^a-zA-Z0-9._-]/g, "_");

const buildUniqueFilename = (filename: string): string => `${crypto.randomUUID()}-${sanitizeFilename(filename)}`;

export const buildUploadKey = ({
	filename,
	workspaceId,
	productId,
	uploadScope = "workspace-assets",
	pendingOwnerId,
}: CreatePresignedUploadOptions & { filename: string }): string => {
	const uniqueFilename = buildUniqueFilename(filename);

	if (uploadScope === "source-files" && workspaceId) {
		return `uploads/${workspaceId}/source-files/${uniqueFilename}`;
	}

	if (uploadScope === "product-assets" && workspaceId && productId) {
		return `uploads/${workspaceId}/product/${productId}/${uniqueFilename}`;
	}

	if (uploadScope === "workspace-assets" && workspaceId) {
		return `uploads/${workspaceId}/workspace/${uniqueFilename}`;
	}

	if (uploadScope === "workspace-assets" && pendingOwnerId) {
		return `uploads/pending/${pendingOwnerId}/${uniqueFilename}`;
	}

	return `uploads/${uniqueFilename}`;
};

export const createPresignedUrl = async (
	filename: string,
	contentType: string,
	options: CreatePresignedUploadOptions = {},
) => {
	const key = buildUploadKey({ filename, ...options });

	const command = new PutObjectCommand({
		Bucket: uploadsBucket,
		Key: key,
		ContentType: contentType,
	});

	const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

	return {uploadUrl, key};
};

export const createPresignedGetUrl = async (key: string) => {
	const command = new GetObjectCommand({
		Bucket: uploadsBucket,
		Key: key,
	});

	const url = await getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRES_IN_SECONDS });

	return url;
};

export const deleteObjectByKey = async (key: string) => {
	if (!key) return;

	await client.send(
		new DeleteObjectCommand({
			Bucket: uploadsBucket,
			Key: key,
		}),
	);
};

const buildCopySource = (bucket: string, key: string): string => {
	const encodedKey = key.split('/').map(encodeURIComponent).join('/');
	return `${bucket}/${encodedKey}`;
};

export const movePendingWorkspaceAssetToWorkspace = async (
	key: string,
	workspaceId: string,
): Promise<string> => {
	const normalizedKey = normalizeKey(key);
	if (!normalizedKey || !normalizedKey.startsWith("uploads/pending/")) return key;

	const fileName = normalizedKey.split('/').pop();
	if (!fileName) return key;

	const targetKey = `uploads/${workspaceId}/workspace/${fileName}`;

	await client.send(
		new CopyObjectCommand({
			Bucket: uploadsBucket,
			CopySource: buildCopySource(uploadsBucket, normalizedKey),
			Key: targetKey,
		}),
	);

	await deleteObjectByKey(normalizedKey);

	return targetKey;
};

type UploadObjectInput = {
	key: string;
	body: Uint8Array | Buffer;
	contentType: string;
};

export const uploadExportObjectByKey = async ({ key, body, contentType }: UploadObjectInput): Promise<void> => {
	await client.send(
		new PutObjectCommand({
			Bucket: exportsBucket,
			Key: key,
			Body: body,
			ContentType: contentType,
		}),
	);
};

const buildAttachmentDisposition = (fileName: string): string => {
	const sanitized = fileName.replace(/[\r\n"]/g, "_").trim();
	const safeFileName = sanitized || "export";
	const encoded = encodeURIComponent(safeFileName);

	return `attachment; filename="${safeFileName}"; filename*=UTF-8''${encoded}`;
};

const normalizePresignedUrlTtl = (ttlSeconds?: number): number => {
	const requestedTtl = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
		? Math.floor(ttlSeconds)
		: VIEW_URL_EXPIRES_IN_SECONDS;

	return Math.max(1, Math.min(requestedTtl, VIEW_URL_EXPIRES_IN_SECONDS));
};

export const createExportPresignedGetUrl = async (
	key: string,
	fileName?: string,
	ttlSeconds?: number,
): Promise<string> => {
	const command = new GetObjectCommand({
		Bucket: exportsBucket,
		Key: key,
		...(fileName ? { ResponseContentDisposition: buildAttachmentDisposition(fileName) } : {}),
	});

	const url = await getSignedUrl(client, command, { expiresIn: normalizePresignedUrlTtl(ttlSeconds) });

	return url;
};

export const createStandardSymbolPresignedGetUrl = async (key: string): Promise<string> => {
	if (!standardSymbolsBucket) {
		throw new Error("Missing required environment variable: STANDARD_SYMBOLS_BUCKET");
	}

	const command = new GetObjectCommand({
		Bucket: standardSymbolsBucket,
		Key: key,
	});

	return getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRES_IN_SECONDS });
};

export type DocumentationFilePresignedUrl = {
	url: string;
	expiresAt: string;
};

export const createDocumentationFilePresignedGetUrl = async (
	key: string,
): Promise<DocumentationFilePresignedUrl> => {
	if (!documentationFilesBucket) {
		throw new Error("Missing required environment variable: DOCUMENTATION_FILES_BUCKET");
	}

	const command = new GetObjectCommand({
		Bucket: documentationFilesBucket,
		Key: key,
	});

	const expiresIn = DOCS_FILE_URL_EXPIRES_IN_SECONDS;
	const url = await getSignedUrl(client, command, { expiresIn });
	const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

	return { url, expiresAt };
};

const normalizeKey = (key: unknown): string | null => {
	if (typeof key !== "string") return null;
	const trimmed = key.trim();
	return trimmed.length > 0 ? trimmed : null;
};

export const createPresignedGetUrlMap = async (keys: string[]): Promise<Map<string, string>> => {
	const uniqueKeys = [...new Set(keys.map(normalizeKey).filter((key): key is string => Boolean(key)))];
	const signedUrlMap = new Map<string, string>();

	for (let i = 0; i < uniqueKeys.length; i += SIGNING_CONCURRENCY) {
		const keyChunk = uniqueKeys.slice(i, i + SIGNING_CONCURRENCY);
		const chunkResults = await Promise.all(
			keyChunk.map(async (key) => {
				try {
					const url = await createPresignedGetUrl(key);
					return { key, url };
				} catch {
					return null;
				}
			}),
		);

		for (const result of chunkResults) {
			if (!result) continue;
			const { key, url } = result;
			signedUrlMap.set(key, url);
		}
	}

	return signedUrlMap;
};

export const createStandardSymbolPresignedGetUrlMap = async (keys: string[]): Promise<Map<string, string>> => {
	const uniqueKeys = [...new Set(keys.map(normalizeKey).filter((key): key is string => Boolean(key)))];
	const signedUrlMap = new Map<string, string>();

	for (let i = 0; i < uniqueKeys.length; i += SIGNING_CONCURRENCY) {
		const keyChunk = uniqueKeys.slice(i, i + SIGNING_CONCURRENCY);
		const chunkResults = await Promise.all(
			keyChunk.map(async (key) => {
				try {
					const url = await createStandardSymbolPresignedGetUrl(key);
					return { key, url };
				} catch {
					return null;
				}
			}),
		);

		for (const result of chunkResults) {
			if (!result) continue;
			signedUrlMap.set(result.key, result.url);
		}
	}

	return signedUrlMap;
};

type EnrichItemsWithSignedUrlParams<T> = {
	items: T[];
	getKey: (item: T) => string | undefined | null;
	setSignedUrl: (item: T, signedUrl: string) => T;
};

export const enrichItemsWithSignedUrls = async <T>({
	items,
	getKey,
	setSignedUrl,
}: EnrichItemsWithSignedUrlParams<T>): Promise<T[]> => {
	if (!items.length) return items;

	const keys = items
		.map((item) => normalizeKey(getKey(item)))
		.filter((key): key is string => Boolean(key));

	if (!keys.length) return items;

	const signedUrlMap = await createPresignedGetUrlMap(keys);

	return items.map((item) => {
		const key = normalizeKey(getKey(item));
		if (!key) return item;

		const signedUrl = signedUrlMap.get(key);
		if (!signedUrl) return item;

		return setSignedUrl(item, signedUrl);
	});
};

type UserAvatarShape = {
	profileAvatar?: string;
};

type WorkspaceLogoShape = {
	logo?: string;
};

type ProjectImageShape = {
	image?: string;
};

type DepartmentImageShape = {
	image?: string;
};

const extractS3AssetKey = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (!trimmed.startsWith("uploads/")) return undefined;
	return trimmed;
};

const decodeUriSafe = (value: string): string => {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
};

const extractUploadsKeyFromText = (value: string): string | undefined => {
	const decodedValue = decodeUriSafe(value.trim());
	const normalizedValue = decodedValue.replace(/\\/g, "/");
	const uploadsIndex = normalizedValue.indexOf("uploads/");
	if (uploadsIndex === -1) return undefined;

	const keyCandidate = normalizedValue
		.slice(uploadsIndex)
		.split("?")[0]
		.split("#")[0]
		.trim();

	if (!keyCandidate.startsWith("uploads/")) return undefined;
	return keyCandidate.length > "uploads/".length ? keyCandidate : undefined;
};

export const normalizePersistedAssetReference = (
	value: unknown,
	fallback = "",
): string => {
	if (typeof value !== "string") return fallback;

	const trimmed = value.trim();
	if (!trimmed) return "";

	const directKey = extractS3AssetKey(trimmed);
	if (directKey) return directKey;

	try {
		const parsedUrl = new URL(trimmed);
		const keyFromPath = extractUploadsKeyFromText(parsedUrl.pathname);
		if (keyFromPath) return keyFromPath;
	} catch {
		// Not a valid URL; continue with raw value parsing.
	}

	const keyFromRawText = extractUploadsKeyFromText(trimmed);
	if (keyFromRawText) return keyFromRawText;

	return trimmed;
};

export const enrichUsersWithProfileAvatarUrls = async <T extends UserAvatarShape>(
	users: T[],
): Promise<T[]> => {
	return enrichItemsWithSignedUrls({
		items: users,
		getKey: (item) => extractS3AssetKey(item.profileAvatar),
		setSignedUrl: (item, signedUrl) => ({
			...item,
			profileAvatar: signedUrl,
		}),
	});
};

export const enrichWorkspaceWithLogoUrl = async <T extends WorkspaceLogoShape>(
	workspace: T | null,
): Promise<T | null> => {
	if (!workspace) return workspace;

	const [workspaceWithSignedLogo] = await enrichItemsWithSignedUrls({
		items: [workspace],
		getKey: (item) => extractS3AssetKey(item.logo),
		setSignedUrl: (item, signedUrl) => ({
			...item,
			logo: signedUrl,
		}),
	});

	return workspaceWithSignedLogo ?? workspace;
};

export const enrichProjectsWithImageUrls = async <T extends ProjectImageShape>(
	projects: T[],
): Promise<T[]> => {
	return enrichItemsWithSignedUrls({
		items: projects,
		getKey: (item) => extractS3AssetKey(item.image),
		setSignedUrl: (item, signedUrl) => ({
			...item,
			image: signedUrl,
		}),
	});
};

export const enrichDepartmentsWithImageUrls = async <T extends DepartmentImageShape>(
	departments: T[],
): Promise<T[]> => {
	return enrichItemsWithSignedUrls({
		items: departments,
		getKey: (item) => extractS3AssetKey(item.image),
		setSignedUrl: (item, signedUrl) => ({
			...item,
			image: signedUrl,
		}),
	});
};
