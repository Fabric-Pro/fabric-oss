import { z } from "zod";
import {
	ARTIFACT_BRAND_SOURCES,
	ARTIFACT_COVER_STYLES,
	ARTIFACT_FONT_FAMILIES,
} from "./artifact-brand-theme";
import { contrastRatio, readableForegroundFor } from "./brand-colors";

/** Public formatting configuration only: never credentials, private assets, or access evidence. */
export const artifactBrandSnapshotSchema = z.strictObject({
	version: z.literal(1),
	source: z.enum(ARTIFACT_BRAND_SOURCES),
	companyName: z.string().max(200).nullable(),
	clientName: z.string().max(200).nullable(),
	primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
	accentColors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(3),
	displayFontFamily: z.enum(ARTIFACT_FONT_FAMILIES),
	bodyFontFamily: z.enum(ARTIFACT_FONT_FAMILIES),
	coverStyle: z.enum(ARTIFACT_COVER_STYLES),
	companyBrandVersion: z.number().int().nonnegative(),
	clientBrandVersion: z.number().int().nonnegative(),
});
export type ArtifactBrandSnapshot = z.infer<typeof artifactBrandSnapshotSchema>;
export const artifactBrandSelectionSchema = z.strictObject({
	source: z.enum(ARTIFACT_BRAND_SOURCES),
	expectedBrandVersion: z.number().int().nonnegative(),
});
export type ArtifactBrandSelection = z.infer<
	typeof artifactBrandSelectionSchema
>;

const escape = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/** Values are schema-validated before they enter either CSS or public markup. */
export function artifactBrandPresentationCss(
	input: ArtifactBrandSnapshot,
	scopeSelector?: string,
): string {
	const brand = artifactBrandSnapshotSchema.parse(input);
	const onPrimary = readableForegroundFor(brand.primaryColor);
	const heading =
		contrastRatio(brand.primaryColor, "#ffffff") >= 4.5
			? brand.primaryColor
			: "#111827";
	const css = `:root{--color-foreground:#111827;--color-background:#ffffff;--color-card:#ffffff;--color-card-foreground:#111827;--color-muted:#f1f5f9;--color-muted-foreground:#475569;--color-border:#cbd5e1;--font-sans:"${brand.bodyFontFamily}",sans-serif;--background:#ffffff;--foreground:#111827;--card:#ffffff;--card-foreground:#111827;--muted:#f1f5f9;--muted-foreground:#475569;--border:#cbd5e1;--artifact-brand-primary:${brand.primaryColor};--artifact-brand-accent:${brand.accentColors[0] ?? brand.primaryColor}}body{background:#ffffff;color:#111827;font-family:"${brand.bodyFontFamily}",sans-serif}h1,h2,h3,h4,.artifact-brand-cover{font-family:"${brand.displayFontFamily}",sans-serif}h1,h2,h3{color:${heading}}.artifact-brand-cover{padding:2rem;border-top:6px solid var(--artifact-brand-primary);margin-bottom:2rem;break-inside:avoid}.artifact-brand-cover[data-cover="DARK"]{background:${brand.primaryColor};color:${onPrimary}}.artifact-brand-cover[data-cover="DARK"] h1{color:${onPrimary}}.artifact-brand-cover[data-cover="LIGHT"]{background:#f8fafc;color:#0f172a}.artifact-brand-cover[data-cover="MINIMAL"]{padding:1rem 0;background:#ffffff;color:#111827}.artifact-brand-parties{font-family:"${brand.bodyFontFamily}",sans-serif;display:flex;flex-wrap:wrap;gap:1.5rem;font-size:.875rem}.artifact-brand-parties small{display:block;opacity:.8}.artifact-brand-parties strong{display:block}`;
	if (!scopeSelector) {
		return css;
	}
	if (!/^#[a-zA-Z0-9_-]+$/.test(scopeSelector)) {
		throw new Error("Invalid brand presentation scope");
	}
	return css.replace(
		/(^|})([^{}]+)\{/g,
		(_match, boundary: string, selectors: string) =>
			`${boundary}${selectors
				.split(",")
				.map((selector) =>
					selector === ":root" || selector === "body"
						? scopeSelector
						: `${scopeSelector} ${selector}`,
				)
				.join(",")}{`,
	);
}

export function artifactBrandCoverHtml(
	input: ArtifactBrandSnapshot,
	title: string,
): string {
	const brand = artifactBrandSnapshotSchema.parse(input);
	return `<header class="artifact-brand-cover" data-cover="${brand.coverStyle}"><h1>${escape(title)}</h1><div class="artifact-brand-parties">${brand.companyName ? `<div><small>Prepared by</small><strong>${escape(brand.companyName)}</strong></div>` : ""}${brand.clientName ? `<div><small>Prepared for</small><strong>${escape(brand.clientName)}</strong></div>` : ""}</div></header>`;
}
