import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { createDocumentationFilePresignedGetUrl } from "./s3-storage";

export type DocumentationVideoSignedUrl = {
	url: string;
	expiresAt: string;
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const cloudFrontDomain = process.env.DOCUMENTATION_CLOUDFRONT_DOMAIN?.trim().replace(/\/$/, "");
const cloudFrontKeyPairId = process.env.DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID?.trim();
const cloudFrontPrivateKeyEnv = process.env.DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY?.trim();
const cloudFrontPrivateKeyParam = process.env.DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY_PARAM?.trim();

const CLOUDFRONT_URL_EXPIRES_IN_SECONDS = parsePositiveInteger(
	process.env.DOCS_VIDEO_URL_EXPIRES_IN_SECONDS,
	86400,
);

let cachedCloudFrontPrivateKeyFromSsm: string | undefined;

const isCloudFrontSigningConfigured = (): boolean =>
	Boolean(
		cloudFrontDomain
		&& cloudFrontKeyPairId
		&& (cloudFrontPrivateKeyEnv || cloudFrontPrivateKeyParam),
	);

const wrapPemBody = (body: string): string => {
	const compactBody = body.replace(/\s+/g, "");
	const chunks = compactBody.match(/.{1,64}/g) ?? [];
	return chunks.join("\n");
};

const normalizePrivateKey = (raw: string): string => {
	const normalizedNewlines = raw.replace(/\\n/g, "\n").trim();
	const pemMatch = normalizedNewlines.match(
		/^(-----BEGIN (?:RSA )?PRIVATE KEY-----)\s+([\s\S]+?)\s+(-----END (?:RSA )?PRIVATE KEY-----)$/,
	);

	if (!pemMatch) return normalizedNewlines;

	const [, header, body, footer] = pemMatch;
	return `${header}\n${wrapPemBody(body)}\n${footer}`;
};

const buildCloudFrontObjectUrl = (objectKey: string): string => {
	if (!cloudFrontDomain) {
		throw new Error("Missing required environment variable: DOCUMENTATION_CLOUDFRONT_DOMAIN");
	}

	const normalizedKey = objectKey.replace(/^\/+/, "");
	return `https://${cloudFrontDomain}/${normalizedKey}`;
};

const loadCloudFrontPrivateKey = async (): Promise<string> => {
	if (cloudFrontPrivateKeyEnv) {
		return normalizePrivateKey(cloudFrontPrivateKeyEnv);
	}

	if (!cloudFrontPrivateKeyParam) {
		throw new Error(
			"Missing required environment variable: DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY or DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY_PARAM",
		);
	}

	if (cachedCloudFrontPrivateKeyFromSsm) {
		return cachedCloudFrontPrivateKeyFromSsm;
	}

	const ssmClient = new SSMClient({});
	const response = await ssmClient.send(
		new GetParameterCommand({
			Name: cloudFrontPrivateKeyParam,
			WithDecryption: true,
		}),
	);

	const privateKeyValue = response.Parameter?.Value?.trim();
	if (!privateKeyValue) {
		throw new Error(
			`CloudFront signing private key SSM parameter is empty: ${cloudFrontPrivateKeyParam}`,
		);
	}

	cachedCloudFrontPrivateKeyFromSsm = normalizePrivateKey(privateKeyValue);
	return cachedCloudFrontPrivateKeyFromSsm;
};

export const createDocumentationVideoCloudFrontSignedUrl = async (
	objectKey: string,
): Promise<DocumentationVideoSignedUrl> => {
	if (!cloudFrontKeyPairId) {
		throw new Error("Missing required environment variable: DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID");
	}

	const privateKey = await loadCloudFrontPrivateKey();
	const expiresIn = CLOUDFRONT_URL_EXPIRES_IN_SECONDS;
	const dateLessThan = new Date(Date.now() + expiresIn * 1000);
	const resourceUrl = buildCloudFrontObjectUrl(objectKey);

	const url = getSignedUrl({
		url: resourceUrl,
		keyPairId: cloudFrontKeyPairId,
		privateKey,
		dateLessThan: dateLessThan.toISOString(),
	});

	return {
		url,
		expiresAt: dateLessThan.toISOString(),
	};
};

/**
 * Returns a signed URL for a documentation video object.
 * Uses CloudFront when domain, key pair id, and private key are configured; otherwise S3 presigned GET.
 * @param {string} objectKey - The S3 object key or path for the video.
 * @return {Promise<DocumentationVideoSignedUrl>} Signed URL and expiry for the video
 */
export const createDocumentationVideoSignedUrl = async (
	objectKey: string,
): Promise<DocumentationVideoSignedUrl> => {
	if (isCloudFrontSigningConfigured()) {
		return createDocumentationVideoCloudFrontSignedUrl(objectKey);
	}

	return createDocumentationFilePresignedGetUrl(objectKey);
};
