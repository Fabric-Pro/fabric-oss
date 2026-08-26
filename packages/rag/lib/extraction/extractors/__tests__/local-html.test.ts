/**
 * These tests guard the property that made HTML worth a dedicated extractor:
 * the model must receive readable prose, not markup. The previous behavior
 * (LocalTextExtractor's raw buffer.toString) satisfied "extraction" on a
 * technicality while handing the model script bodies and base64 data URIs.
 */

import { UPLOAD_SIZE_LIMITS } from "@repo/utils";
import { DEFAULT_MAX_ATTACHMENT_BYTES } from "@repo/utils/attachment";
import { describe, expect, it } from "vitest";
import { LocalHtmlExtractor, MAX_HTML_EXTRACTION_BYTES } from "../local-html";

const extractor = new LocalHtmlExtractor();

const SAMPLE = `<!doctype html>
<html>
	<head>
		<title>Quarterly Report</title>
		<style>body { color: red; }</style>
		<script>window.__token = "s3cr3t-value";</script>
	</head>
	<body>
		<h1>Revenue</h1>
		<p>Revenue grew by 12% this quarter.</p>
		<ul><li>North America</li><li>EMEA</li></ul>
	</body>
</html>`;

const TABLE_SAMPLE = `<table><thead><tr><th>Region</th><th>Q1</th><th>Q2</th></tr></thead>
<tbody><tr><td>NA</td><td>120</td><td>140</td></tr>
<tr><td>EMEA</td><td>90</td><td>95</td></tr></tbody></table>`;

describe("LocalHtmlExtractor", () => {
	it("declares only the canonical html mime", () => {
		expect(extractor.supportedMimeTypes).toEqual(["text/html"]);
		expect(extractor.name).toBe("local-html");
	});

	it("returns the readable prose", async () => {
		const result = await extractor.extract(
			Buffer.from(SAMPLE, "utf-8"),
			"report.html",
		);
		expect(result.text).toContain("Revenue grew by 12% this quarter.");
		expect(result.text).toContain("North America");
		expect(result.text).toContain("EMEA");
	});

	it("drops script and style content entirely", async () => {
		// The whole point. Script bodies reaching a prompt are both wasted
		// tokens and an injection surface.
		const result = await extractor.extract(
			Buffer.from(SAMPLE, "utf-8"),
			"report.html",
		);
		expect(result.text).not.toContain("s3cr3t-value");
		expect(result.text).not.toContain("color: red");
		expect(result.text).not.toContain("<script");
	});

	it("keeps table cells and rows separated instead of run together", async () => {
		// html-to-text does not format tables by default. Without an explicit
		// "dataTable" selector, "Region", "Q1", "Q2", "NA", "120", "140" all
		// concatenate into one unbroken run — worse model input than the raw
		// markup this extractor exists to replace, since even raw markup keeps
		// <td> boundaries. Asserted against the extractor's real output.
		const result = await extractor.extract(
			Buffer.from(TABLE_SAMPLE, "utf-8"),
			"table.html",
		);
		expect(result.text).not.toContain("RegionQ1Q2");
		expect(result.text).not.toContain("NA120140");
		expect(result.text).not.toContain("EMEA9095");

		const lines = result.text.split("\n").map((line) => line.trim());
		const naRow = lines.find((line) => line.startsWith("NA"));
		const emeaRow = lines.find((line) => line.startsWith("EMEA"));
		expect(naRow).toBeDefined();
		expect(emeaRow).toBeDefined();
		expect(naRow).toContain("120");
		expect(naRow).toContain("140");
		expect(emeaRow).toContain("90");
		expect(emeaRow).toContain("95");
	});

	it("emits no angle-bracket markup", async () => {
		const result = await extractor.extract(
			Buffer.from(SAMPLE, "utf-8"),
			"report.html",
		);
		expect(result.text).not.toContain("<h1>");
		expect(result.text).not.toContain("<!doctype");
	});

	it("reports itself as the extractor used, at zero cost", async () => {
		const result = await extractor.extract(
			Buffer.from(SAMPLE, "utf-8"),
			"report.html",
		);
		expect(result.extractorUsed).toBe("local-html");
		expect(result.cost).toBe(0);
	});

	it("still yields text from malformed html", async () => {
		// AC-5: a valid extension with corrupt content must not fail the upload.
		// html-to-text is lenient; if it ever stops being, the factory's
		// fallback chain to local-text is the second line of defence.
		const result = await extractor.extract(
			Buffer.from("<html><body><p>unclosed<div>text", "utf-8"),
			"broken.html",
		);
		expect(result.text).toContain("unclosed");
	});

	it("yields empty text rather than throwing on an empty file", async () => {
		const result = await extractor.extract(
			Buffer.from("", "utf-8"),
			"e.html",
		);
		expect(result.text).toBe("");
	});

	it("sits above both upload caps so it never silently degrades a real file", () => {
		// Throwing does not reject the upload — the factory falls through to
		// local-text and the model gets raw markup. So this ceiling must stay
		// above the real attachment and context caps, not a hardcoded copy of
		// their current values — asserting against a literal would stay green
		// if either cap were raised without this ceiling following, silently
		// reintroducing the raw-markup degradation for every large file.
		expect(MAX_HTML_EXTRACTION_BYTES).toBeGreaterThan(
			DEFAULT_MAX_ATTACHMENT_BYTES,
		);
		expect(MAX_HTML_EXTRACTION_BYTES).toBeGreaterThan(
			UPLOAD_SIZE_LIMITS.DOCUMENT,
		);
	});

	it("refuses input above the backstop rather than parsing unbounded", async () => {
		const oversized = Buffer.alloc(MAX_HTML_EXTRACTION_BYTES + 1, 0x20);
		await expect(extractor.extract(oversized, "huge.html")).rejects.toThrow(
			/too large/i,
		);
	});

	it("is always available and free to estimate", async () => {
		expect(await extractor.isAvailable()).toBe(true);
		expect(await extractor.estimateCost(Buffer.from(SAMPLE))).toBe(0);
	});
});
