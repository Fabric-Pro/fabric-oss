/** Fonts shipped with Fabric so previews and offline exports can use the same families. */
export const ARTIFACT_FONT_FAMILIES = [
	"Inter",
	"Poppins",
	"JetBrains Mono",
] as const;
export type ArtifactFontFamily = (typeof ARTIFACT_FONT_FAMILIES)[number];

export const ARTIFACT_COVER_STYLES = ["DARK", "LIGHT", "MINIMAL"] as const;
export type ArtifactCoverStyle = (typeof ARTIFACT_COVER_STYLES)[number];

export const ARTIFACT_BRAND_SOURCES = ["COMPANY", "CLIENT"] as const;
export type ArtifactBrandSource = (typeof ARTIFACT_BRAND_SOURCES)[number];

export function isArtifactFontFamily(
	value: unknown,
): value is ArtifactFontFamily {
	return (
		typeof value === "string" &&
		ARTIFACT_FONT_FAMILIES.some((family) => family === value)
	);
}

export function isArtifactCoverStyle(
	value: unknown,
): value is ArtifactCoverStyle {
	return (
		typeof value === "string" &&
		ARTIFACT_COVER_STYLES.some((style) => style === value)
	);
}
