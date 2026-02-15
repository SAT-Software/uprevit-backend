import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const region = process.env.AWS_REGION;
const bucket = process.env.UPLOADS_BUCKET;

if (!region) throw new Error("Missing required environment variable: AWS_REGION");
if (!bucket) throw new Error("Missing required environment variable: UPLOADS_BUCKET");

const VIEW_URL_EXPIRES_IN_SECONDS = Number(process.env.S3_VIEW_URL_EXPIRES_IN_SECONDS ?? 43200);
const SIGNING_CONCURRENCY = Number(process.env.S3_SIGNING_CONCURRENCY ?? 25);

export const client = new S3Client({ region });

export const createPresignedUrl = async (filename: string, contentType: string) => {
	const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
	const key = `uploads/${crypto.randomUUID()}-${safeFilename}`;

	const command = new PutObjectCommand({
		Bucket: bucket,
		Key: key,
		ContentType: contentType,
	});

	const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

	return {uploadUrl, key};
};

export const createPresignedGetUrl = async (key: string) => {
	const command = new GetObjectCommand({
		Bucket: bucket,
		Key: key,
	});

	const url = await getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRES_IN_SECONDS });

	return url;
};

export const deleteObjectByKey = async (key: string) => {
	if (!key) return;

	await client.send(
		new DeleteObjectCommand({
			Bucket: bucket,
			Key: key,
		}),
	);
};

const normalizeKey = (key?: string | null): string | null => {
	if (!key) return null;
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
