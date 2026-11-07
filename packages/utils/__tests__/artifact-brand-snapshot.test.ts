import { describe, expect, it } from "vitest";
import {
	artifactBrandCoverHtml,
	artifactBrandPresentationCss,
	artifactBrandSnapshotSchema,
} from "../lib/artifact-brand-snapshot";
import {
	ARTIFACT_STATIC_CSP,
	sanitizeArtifactHtmlFragment,
} from "../lib/artifact-static-html";

const brand = {
	version: 1 as const,
	source: "CLIENT" as const,
	companyName: "Example Studio",
	clientName: "Example Client",
	primaryColor: "#ffffff",
	accentColors: [],
	displayFontFamily: "Inter" as const,
	bodyFontFamily: "Poppins" as const,
	coverStyle: "DARK" as const,
	companyBrandVersion: 1,
	clientBrandVersion: 2,
};
describe("artifact brand formatting snapshot", () => {
	it("refuses private asset fields and CSS injection", () => {
		expect(
			artifactBrandSnapshotSchema.safeParse({
				...brand,
				logoKey: "private-key",
			}).success,
		).toBe(false);
		expect(
			artifactBrandSnapshotSchema.safeParse({
				...brand,
				primaryColor: "red;}body{display:none}",
			}).success,
		).toBe(false);
		expect(() =>
			artifactBrandPresentationCss(brand, "body,iframe"),
		).toThrow();
	});
	it("keeps light brand colors readable and bounds formatting to the preview root", () => {
		const css = artifactBrandPresentationCss(brand, "#brand-preview");
		expect(css).toContain("background:#ffffff;color:#111827");
		expect(css).toMatch(/data-cover="DARK"\]\{background:#ffffff;color:#/);
		expect(css).not.toContain("background:#ffffff;color:#fff}");
		expect(css).toContain("#brand-preview h1");
		expect(css).not.toMatch(/(^|})body\{/);
	});
	it("escapes party names and document titles without changing their roles", () => {
		const html = artifactBrandCoverHtml(
			{ ...brand, companyName: "<studio>", clientName: '"client"' },
			"<img src=x>",
		);
		expect(html).toContain("Prepared by</small><strong>&lt;studio&gt;");
		expect(html).toContain(
			"Prepared for</small><strong>&quot;client&quot;",
		);
		expect(html).not.toContain("<img");
	});
});

it("keeps generated report HTML static and offline", () => {
	const html = sanitizeArtifactHtmlFragment(
		'<html><body><h2 onclick="alert(1)">Delivery</h2><script>alert(2)</script><iframe src="https://example.com"></iframe><img src="https://example.com/image"></body></html>',
	);
	expect(html).toContain("<h2>Delivery</h2>");
	expect(html).not.toContain("<script");
	expect(html).not.toContain("onclick=");
	expect(html).not.toContain("<iframe");
	expect(ARTIFACT_STATIC_CSP).toContain("default-src 'none'");
	expect(ARTIFACT_STATIC_CSP).toContain("font-src data:");
	expect(ARTIFACT_STATIC_CSP).not.toContain("unsafe-eval");
});
