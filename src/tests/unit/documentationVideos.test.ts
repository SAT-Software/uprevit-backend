import { describe, expect, it } from "@jest/globals";
import {
	getDocumentationVideoObjectKey,
	isDocumentationVideoKey,
} from "../../config/documentationVideos";

describe("documentationVideos allowlist", () => {
	it("recognizes allowlisted keys", () => {
		expect(isDocumentationVideoKey("product.products-intro")).toBe(true);
		expect(getDocumentationVideoObjectKey("product.products-intro")).toBe(
			"videos/product/products-intro.mp4",
		);
	});

	it("rejects unknown keys", () => {
		expect(isDocumentationVideoKey("not.a.video")).toBe(false);
		expect(getDocumentationVideoObjectKey("not.a.video")).toBeNull();
	});
});
