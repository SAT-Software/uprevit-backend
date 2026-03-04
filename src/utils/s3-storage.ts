import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const region = process.env.AWS_REGION;
const uploadsBucket = process.env.UPLOADS_BUCKET;
const exportsBucket = process.env.EXPORTS_BUCKET;

if (!region) throw new Error("Missing required environment variable: AWS_REGION");
if (!uploadsBucket) throw new Error("Missing required environment variable: UPLOADS_BUCKET");
if (!exportsBucket) throw new Error("Missing required environment variable: EXPORTS_BUCKET");

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const VIEW_URL_EXPIRES_IN_SECONDS = parsePositiveInteger(process.env.S3_VIEW_URL_EXPIRES_IN_SECONDS, 43200);
const SIGNING_CONCURRENCY = parsePositiveInteger(process.env.S3_SIGNING_CONCURRENCY, 25);

export const client = new S3Client({ region });

export const createPresignedUrl = async (filename: string, contentType: string) => {
	const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
	const key = `uploads/${crypto.randomUUID()}-${safeFilename}`;

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

export const createExportPresignedGetUrl = async (key: string): Promise<string> => {
	const command = new GetObjectCommand({
		Bucket: exportsBucket,
		Key: key,
	});

	const url = await getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRES_IN_SECONDS });

	return url;
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
