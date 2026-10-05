import { describe, expect, it } from "vitest";
import { formatFileSize } from "../instructions-file-size";

describe("formatFileSize", () => {
	it.each([
		[0, "0 B"],
		[212, "212 B"],
		[1023, "1023 B"],
		[1024, "1.0 KB"],
		[6349, "6.2 KB"],
		[1024 * 1024 - 1, "1.0 MB"],
		[1024 * 1024, "1.0 MB"],
		[1.5 * 1024 * 1024, "1.5 MB"],
	])("writes %d bytes as %s", (bytes, written) => {
		expect(formatFileSize(bytes)).toBe(written);
	});
});
