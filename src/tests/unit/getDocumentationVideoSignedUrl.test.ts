import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { APIGatewayProxyEvent } from "aws-lambda";

jest.mock("../../utils/authUtils", () => ({
	authenticateRequest: jest.fn(),
}));

jest.mock("../../utils/documentation-video-url", () => ({
	createDocumentationVideoSignedUrl: jest.fn(),
}));

const authUtils = jest.requireMock("../../utils/authUtils") as any;

const documentationVideoUrl = jest.requireMock("../../utils/documentation-video-url") as any;

const { lambdaHandler } = require("../../controllers/docs/getDocumentationVideoSignedUrl");

const buildEvent = (videoKey?: string): APIGatewayProxyEvent =>
	({
		pathParameters: videoKey ? { videoKey } : undefined,
		headers: { Authorization: "Bearer test-token" },
	}) as unknown as APIGatewayProxyEvent;

describe("getDocumentationVideoSignedUrl", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("returns 401 when authentication fails", async () => {
		authUtils.authenticateRequest.mockResolvedValue({
			isValid: false,
			error: { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) },
		});

		const response = await lambdaHandler(buildEvent("product.products-intro"));

		expect(response.statusCode).toBe(401);
		expect(documentationVideoUrl.createDocumentationVideoSignedUrl).not.toHaveBeenCalled();
	});

	it("returns 404 for unknown videoKey", async () => {
		authUtils.authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: {},
			token: "test-token",
		});

		const response = await lambdaHandler(buildEvent("unknown.video-key"));

		expect(response.statusCode).toBe(404);
		expect(documentationVideoUrl.createDocumentationVideoSignedUrl).not.toHaveBeenCalled();
	});

	it("returns signed url for allowlisted videoKey", async () => {
		authUtils.authenticateRequest.mockResolvedValue({
			isValid: true,
			payload: {},
			token: "test-token",
		});

		documentationVideoUrl.createDocumentationVideoSignedUrl.mockResolvedValue({
			url: "https://d123.cloudfront.net/videos/product/products-intro.mp4?Signature=abc",
			expiresAt: "2026-05-26T12:00:00.000Z",
		});

		const response = await lambdaHandler(buildEvent("product.products-intro"));

		expect(response.statusCode).toBe(200);
		expect(documentationVideoUrl.createDocumentationVideoSignedUrl).toHaveBeenCalledWith(
			"videos/product/products-intro.mp4",
		);

		const body = JSON.parse(response.body);
		expect(body.result.url).toContain("cloudfront.net");
		expect(body.result.expiresAt).toBe("2026-05-26T12:00:00.000Z");
	});
});
