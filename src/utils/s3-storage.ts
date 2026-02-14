import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const region = process.env.AWS_REGION;
const bucket = process.env.UPLOADS_BUCKET;

if (!region) throw new Error("Missing required environment variable: AWS_REGION");
if (!bucket) throw new Error("Missing required environment variable: UPLOADS_BUCKET");

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

	const url = await getSignedUrl(client, command, { expiresIn: 3600 });

	return url;
};