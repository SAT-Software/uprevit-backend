import { GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectId } from 'mongodb';
import {
	SUPPORT_ATTACHMENT_COLLECTION,
	SUPPORT_ATTACHMENT_QUOTA_COLLECTION,
	type SupportAttachment,
	type SupportAttachmentContentType,
	type SupportAttachmentQuota,
} from '../models/supportAttachment';
import { getDb } from './db';

const UPLOAD_EXPIRES_IN_SECONDS = 300;
export const SUPPORT_ATTACHMENT_VIEW_EXPIRES_IN_SECONDS = 60;
export const SUPPORT_ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const client = new S3Client({ region: process.env.AWS_REGION });

const getBucket = (): string => {
	const bucket = process.env.SUPPORT_ATTACHMENTS_BUCKET?.trim();
	if (!bucket) throw new Error('Missing required environment variable: SUPPORT_ATTACHMENTS_BUCKET');
	return bucket;
};

let hasEnsuredIndexes = false;

export const ensureSupportAttachmentIndexes = async () => {
	if (hasEnsuredIndexes) return;
	const db = await getDb();
	await Promise.all([
		db.collection<SupportAttachment>(SUPPORT_ATTACHMENT_COLLECTION).createIndex({ attachmentId: 1 }, { unique: true }),
		db.collection<SupportAttachmentQuota>(SUPPORT_ATTACHMENT_QUOTA_COLLECTION).createIndex({ userId: 1 }, { unique: true }),
	]);
	hasEnsuredIndexes = true;
};

/**
 * Atomically reserves one upload slot in the user's rolling one-hour window. Returns false when the limit is reached.
 * @param {ObjectId} userId User ID
 * @param {number} limit Maximum uploads per hour
 */
export const reserveSupportAttachmentUpload = async (userId: ObjectId, limit: number): Promise<boolean> => {
	const db = await getDb();
	const quotas = db.collection<SupportAttachmentQuota>(SUPPORT_ATTACHMENT_QUOTA_COLLECTION);
	const now = Date.now();

	await quotas.updateOne(
		{ userId },
		{ $pull: { uploads: { $lt: now - 60 * 60 * 1000 } } },
		{ upsert: true },
	);
	const result = await quotas.updateOne(
		{ userId, $expr: { $lt: [{ $size: { $ifNull: ['$uploads', []] } }, limit] } },
		{ $push: { uploads: now } },
	);
	return result.modifiedCount === 1;
};

export const supportAttachmentKey = (attachmentId: string): string => `attachments/${attachmentId}`;

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
	signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

const MAGIC_BYTES: Record<SupportAttachmentContentType, (bytes: Uint8Array) => boolean> = {
	'image/png': (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	'image/jpeg': (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
	'image/gif': (bytes) => startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')),
	'image/webp': (bytes) => startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8),
};

/**
 * Creates a short-lived S3 POST policy bound to the exact key, content type and byte size.
 * @param {string} key Object key
 * @param {SupportAttachmentContentType} contentType Allowed content type
 * @param {number} sizeBytes Exact upload size in bytes
 * @return {Promise<PresignedPost>} Presigned POST URL and fields
 */
export const createSupportAttachmentUpload = (key: string, contentType: SupportAttachmentContentType, sizeBytes: number) =>
	createPresignedPost(client, {
		Bucket: getBucket(),
		Key: key,
		Fields: { 'Content-Type': contentType },
		Conditions: [
			['content-length-range', sizeBytes, sizeBytes],
			['eq', '$Content-Type', contentType],
		],
		Expires: UPLOAD_EXPIRES_IN_SECONDS,
	});

/**
 * Confirms the uploaded object matches the expected type, size and image signature. Returns the verified S3 version
 * so later reads ignore any re-upload to the same key, or null when the object is missing or invalid.
 * @param {string} key Object key
 * @param {SupportAttachmentContentType} contentType Expected content type
 * @param {number} sizeBytes Expected size in bytes
 */
export const verifySupportAttachmentObject = async (
	key: string,
	contentType: SupportAttachmentContentType,
	sizeBytes: number,
): Promise<string | null> => {
	const bucket = getBucket();

	let head;
	try {
		head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
	} catch (error) {
		const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
		if (status === 403 || status === 404) return null;
		throw error;
	}

	const versionId = head.VersionId;
	if (!versionId || versionId === 'null' || head.ContentLength !== sizeBytes || head.ContentType !== contentType) {
		return null;
	}

	const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId, Range: 'bytes=0-15' }));
	const bytes = await object.Body?.transformToByteArray();
	if (!bytes || !MAGIC_BYTES[contentType](bytes)) return null;

	return versionId;
};

export const createSupportAttachmentViewUrl = (key: string, versionId: string, contentType: SupportAttachmentContentType) =>
	getSignedUrl(
		client,
		new GetObjectCommand({
			Bucket: getBucket(),
			Key: key,
			VersionId: versionId,
			ResponseContentType: contentType,
			ResponseContentDisposition: 'inline',
			ResponseCacheControl: 'no-store',
		}),
		{ expiresIn: SUPPORT_ATTACHMENT_VIEW_EXPIRES_IN_SECONDS },
	);
