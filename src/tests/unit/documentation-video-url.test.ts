import { afterEach, describe, expect, it, jest } from "@jest/globals";

const mockGetSignedUrl = jest.fn() as jest.Mock;
const mockCreateDocumentationFilePresignedGetUrl = jest.fn() as jest.Mock;
const mockSend = jest.fn() as jest.Mock;

jest.mock("@aws-sdk/cloudfront-signer", () => ({
	getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock("@aws-sdk/client-ssm", () => ({
	SSMClient: jest.fn().mockImplementation(() => ({
		send: (...args: unknown[]) => mockSend(...args),
	})),
	GetParameterCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

jest.mock("../../utils/s3-storage", () => ({
	createDocumentationFilePresignedGetUrl: (...args: unknown[]) =>
		mockCreateDocumentationFilePresignedGetUrl(...args),
}));

const ORIGINAL_ENV = { ...process.env };

describe("documentation-video-url", () => {
	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		jest.clearAllMocks();
	});

	it("uses S3 presigned URL when CloudFront env is not configured", async () => {
		process.env = {
			...ORIGINAL_ENV,
			AWS_REGION: "us-east-1",
		};
		delete process.env.DOCUMENTATION_CLOUDFRONT_DOMAIN;
		delete process.env.DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID;
		delete process.env.DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY;

		mockCreateDocumentationFilePresignedGetUrl.mockResolvedValue({
			url: "https://bucket.s3.amazonaws.com/videos/foo.mp4",
			expiresAt: "2026-05-26T12:00:00.000Z",
		} as never);

		let createDocumentationVideoSignedUrl: typeof import("../../utils/documentation-video-url").createDocumentationVideoSignedUrl;
		jest.isolateModules(() => {
			({ createDocumentationVideoSignedUrl } = require("../../utils/documentation-video-url"));
		});

		const result = await createDocumentationVideoSignedUrl!("videos/foo.mp4");

		expect(result.url).toContain("s3.amazonaws.com");
		expect(mockCreateDocumentationFilePresignedGetUrl).toHaveBeenCalledWith("videos/foo.mp4");
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("uses CloudFront signed URL when domain, key pair id, and inline private key are set", async () => {
		process.env = {
			...ORIGINAL_ENV,
			AWS_REGION: "us-east-1",
			DOCUMENTATION_CLOUDFRONT_DOMAIN: "d123.cloudfront.net",
			DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID: "KTESTKEY",
			DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY:
				"-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
		};

		mockGetSignedUrl.mockReturnValue(
			"https://d123.cloudfront.net/videos/foo.mp4?Expires=1&Signature=abc",
		);

		let createDocumentationVideoSignedUrl: typeof import("../../utils/documentation-video-url").createDocumentationVideoSignedUrl;
		jest.isolateModules(() => {
			({ createDocumentationVideoSignedUrl } = require("../../utils/documentation-video-url"));
		});

		const result = await createDocumentationVideoSignedUrl!("videos/foo.mp4");

		expect(result.url).toContain("d123.cloudfront.net");
		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://d123.cloudfront.net/videos/foo.mp4",
				keyPairId: "KTESTKEY",
				privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
			}),
		);
		expect(mockCreateDocumentationFilePresignedGetUrl).not.toHaveBeenCalled();
	});

	it("loads the CloudFront private key from SSM when only the parameter path is configured", async () => {
		process.env = {
			...ORIGINAL_ENV,
			AWS_REGION: "us-east-1",
			DOCUMENTATION_CLOUDFRONT_DOMAIN: "d123.cloudfront.net",
			DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID: "KTESTKEY",
			DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY_PARAM: "/uprevit/develop/documentation-cloudfront-private-key",
		};
		delete process.env.DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY;

		mockSend.mockResolvedValue({
			Parameter: {
				Value: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
			},
		} as never);
		mockGetSignedUrl.mockReturnValue(
			"https://d123.cloudfront.net/videos/foo.mp4?Expires=1&Signature=abc",
		);

		let createDocumentationVideoSignedUrl: typeof import("../../utils/documentation-video-url").createDocumentationVideoSignedUrl;
		jest.isolateModules(() => {
			({ createDocumentationVideoSignedUrl } = require("../../utils/documentation-video-url"));
		});

		const result = await createDocumentationVideoSignedUrl!("videos/foo.mp4");

		expect(result.url).toContain("d123.cloudfront.net");
		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				Name: "/uprevit/develop/documentation-cloudfront-private-key",
				WithDecryption: true,
			}),
		);
		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				keyPairId: "KTESTKEY",
				privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
			}),
		);
	});

	it("normalizes a private key that was flattened with spaces", async () => {
		process.env = {
			...ORIGINAL_ENV,
			AWS_REGION: "us-east-1",
			DOCUMENTATION_CLOUDFRONT_DOMAIN: "d123.cloudfront.net",
			DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID: "KTESTKEY",
			DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY:
				"-----BEGIN PRIVATE KEY----- abc def ghi -----END PRIVATE KEY-----",
		};

		mockGetSignedUrl.mockReturnValue(
			"https://d123.cloudfront.net/videos/foo.mp4?Expires=1&Signature=abc",
		);

		let createDocumentationVideoSignedUrl: typeof import("../../utils/documentation-video-url").createDocumentationVideoSignedUrl;
		jest.isolateModules(() => {
			({ createDocumentationVideoSignedUrl } = require("../../utils/documentation-video-url"));
		});

		await createDocumentationVideoSignedUrl!("videos/foo.mp4");

		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				privateKey: "-----BEGIN PRIVATE KEY-----\nabcdefghi\n-----END PRIVATE KEY-----",
			}),
		);
	});
});
