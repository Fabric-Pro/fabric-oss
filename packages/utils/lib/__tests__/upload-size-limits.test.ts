import { describe, expect, it } from "vitest";
import { formatSizeLimit, UPLOAD_SIZE_LIMITS } from "../upload-size-limits";

describe("UPLOAD_SIZE_LIMITS", () => {
	it("caps images and spreadsheets at 10MB", () => {
		expect(UPLOAD_SIZE_LIMITS.IMAGE).toBe(10 * 1024 * 1024);
		expect(UPLOAD_SIZE_LIMITS.SPREADSHEET).toBe(10 * 1024 * 1024);
	});

	it("allows documents and generic files up to 20MB", () => {
		expect(UPLOAD_SIZE_LIMITS.DOCUMENT).toBe(20 * 1024 * 1024);
		expect(UPLOAD_SIZE_LIMITS.FILE).toBe(20 * 1024 * 1024);
	});
});

describe("formatSizeLimit", () => {
	it("formats bytes into a user-friendly MB maximum string", () => {
		expect(formatSizeLimit(10 * 1024 * 1024)).toBe("10MB maximum");
		expect(formatSizeLimit(20 * 1024 * 1024)).toBe("20MB maximum");
	});
});
