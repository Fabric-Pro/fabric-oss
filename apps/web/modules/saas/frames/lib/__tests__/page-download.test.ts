import { describe, expect, it } from "vitest";
import { checkDownload, formatFileSize } from "../page-download";

const CSV = btoa("a,b\n1,2\n");

function offer(overrides: Partial<Parameters<typeof checkDownload>[0]> = {}) {
	return checkDownload({
		filename: "report.csv",
		mimeType: "text/csv",
		dataBase64: CSV,
		...overrides,
	});
}

describe("checkDownload", () => {
	it("accepts a file of a kind on the list, with its size", () => {
		expect(offer()).toEqual({
			ok: true,
			download: {
				filename: "report.csv",
				mimeType: "text/csv",
				bytes: 8,
				dataBase64: CSV,
			},
		});
	});

	it.each([
		["csv", "text/csv"],
		["json", "application/json"],
		["txt", "text/plain"],
		["md", "text/markdown"],
		["pdf", "application/pdf"],
		["png", "image/png"],
		["svg", "image/svg+xml"],
	])("accepts .%s as %s", (extension, mimeType) => {
		expect(offer({ filename: `file.${extension}`, mimeType }).ok).toBe(
			true,
		);
	});

	it("takes the extension in any case and the type with a charset", () => {
		expect(
			offer({
				filename: "REPORT.CSV",
				mimeType: "Text/CSV; charset=utf-8",
			}),
		).toMatchObject({
			ok: true,
			download: { filename: "REPORT.CSV", mimeType: "text/csv" },
		});
	});

	it("reports the size of text whose length is not a multiple of three", () => {
		const text = "hello";

		expect(offer({ dataBase64: btoa(text) })).toMatchObject({
			ok: true,
			download: { bytes: text.length },
		});
	});

	it.each([
		["a program", "setup.exe", "application/octet-stream"],
		["a page", "index.html", "text/html"],
		["a script", "run.js", "text/javascript"],
		["a name with no extension", "report", "text/csv"],
		["a name that is only an extension", ".csv", "text/csv"],
		[
			"an extension that is a property of every object",
			"x.constructor",
			"text/csv",
		],
		["another that is", "x.__proto__", "text/csv"],
	])("refuses %s", (_label, filename, mimeType) => {
		expect(offer({ filename, mimeType })).toMatchObject({ ok: false });
	});

	it("refuses a type that does not belong to the extension", () => {
		const answer = offer({ filename: "report.csv", mimeType: "text/html" });

		expect(answer).toMatchObject({ ok: false });
		expect(!answer.ok && answer.error).toContain("text/csv");
	});

	it("refuses text that is not base64", () => {
		expect(offer({ dataBase64: "not base64 at all!" })).toMatchObject({
			ok: false,
		});
		expect(offer({ dataBase64: "a=b=" })).toMatchObject({ ok: false });
	});

	it("refuses a file over 10 MB and accepts one of exactly 10 MB", () => {
		const limit = 10 * 1024 * 1024;
		const atLimit = btoa("A".repeat(limit));
		const over = btoa("A".repeat(limit + 1));

		expect(offer({ dataBase64: atLimit })).toMatchObject({
			ok: true,
			download: { bytes: limit },
		});
		expect(offer({ dataBase64: over })).toMatchObject({
			ok: false,
			error: "A download may be at most 10 MB.",
		});
	});

	it("offers the cleaned name, not the one it was sent", () => {
		expect(offer({ filename: "../x/report.csv" })).toMatchObject({
			ok: true,
			download: { filename: "report.csv" },
		});
	});

	it("offers a name without characters that reorder or hide text", () => {
		expect(
			offer({ filename: "report‮txt.csv", mimeType: "text/csv" }),
		).toMatchObject({
			ok: true,
			download: { filename: "reporttxt.csv" },
		});
	});

	it("refuses text of a length base64 cannot have", () => {
		expect(offer({ dataBase64: "YSxiCjEsMgo" })).toMatchObject({
			ok: false,
			error: "The file could not be read.",
		});
	});
});

describe("formatFileSize", () => {
	it.each([
		[0, "0 B"],
		[1023, "1023 B"],
		[1024, "1 KB"],
		[1536, "2 KB"],
		[1024 * 1024, "1.0 MB"],
		[10 * 1024 * 1024, "10.0 MB"],
	])("writes %i bytes as %s", (bytes, expected) => {
		expect(formatFileSize(bytes)).toBe(expected);
	});
});
