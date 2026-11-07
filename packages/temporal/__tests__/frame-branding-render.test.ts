import type { FrameDocument } from "@repo/database";
import { describe, expect, it } from "vitest";
import { renderFrameToHTML } from "../src/activities/frame-export/generate-pdf";
import { renderFrameMarkdown } from "../src/activities/frame-export/render-markdown";

describe("branded Frame static rendering", () => {
	it("renders report headings, emphasis and GFM tables instead of raw Markdown", () => {
		const html = renderFrameMarkdown(
			"## Delivery\n\n**Reviewed** work.\n\n| Item | Status |\n| --- | --- |\n| Scope | Ready |",
		);
		expect(html).toContain("<h2>Delivery</h2>");
		expect(html).toContain("<strong>Reviewed</strong>");
		expect(html).toContain("<th>Item</th>");
		expect(html).toContain("<td>Ready</td>");
	});
	it("treats authored HTML as text and refuses active links or remote images", () => {
		const html = renderFrameMarkdown(
			"<script>alert(1)</script>\n\n[unsafe](javascript:alert) ![remote](https://example.com/a.png)",
		);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="javascript:');
		expect(html).not.toContain("<img");
	});
	it("includes a bounded scalar theme, offline fonts and both identities", () => {
		const html = renderFrameToHTML({
			version: 1,
			kind: "frame",
			title: "Example report",
			blocks: [
				{
					id: "report",
					type: "markdown",
					content: "## Delivery\n\nReviewed facts.",
				},
			],
			theme: {
				mode: "light",
				branding: {
					version: 1,
					source: "CLIENT",
					companyName: "Example Studio",
					clientName: "Example Client",
					primaryColor: "#ffffff",
					accentColors: [],
					displayFontFamily: "Inter",
					bodyFontFamily: "Poppins",
					coverStyle: "LIGHT",
					companyBrandVersion: 1,
					clientBrandVersion: 2,
				},
			},
		} as FrameDocument);
		expect(html).toContain("<h2>Delivery</h2>");
		expect(html).toContain("Prepared by");
		expect(html).toContain("Prepared for");
		expect(html).toContain("data:font/ttf;base64,");
	});
});
