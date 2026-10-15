import { GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SupportAttachmentContentType } from '../models/supportAttachment';

const UPLOAD_EXPIRES_IN_SECONDS = 300;
export const SUPPORT_ATTACHMENT_VIEW_EXPIRES_IN_SECONDS = 60;
export const SUPPORT_ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const client = new S3Client({ region: process.env.AWS_REGION });

const getBucket = (): string => {
	const bucket = process.env.SUPPORT_ATTACHMENTS_BUCKET?.trim();
	if (!bucket) throw new Error('Missing required environment variable: SUPPORT_ATTACHMENTS_BUCKET');
	return bucket;
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
