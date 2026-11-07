import { isArtifactFontFamily } from "./artifact-brand-theme";
import { ARTIFACT_FONT_FACES } from "./generated/artifact-brand-font-data";

/** Committed font bytes only. Safe inside the offline Frame CSP; never persisted. */
export function artifactBrandFontFaceCss(
	theme: {
		displayFontFamily?: string | null;
		bodyFontFamily?: string | null;
	} = {},
): string {
	const families = new Set([
		isArtifactFontFamily(theme.displayFontFamily)
			? theme.displayFontFamily
			: "Poppins",
		isArtifactFontFamily(theme.bodyFontFamily)
			? theme.bodyFontFamily
			: "Inter",
		"JetBrains Mono",
	]);
	return ARTIFACT_FONT_FACES.filter((face) => families.has(face.family))
		.map(
			(face) =>
				`@font-face {\n\tfont-family: "${face.family}";\n\tfont-style: normal;\n\tfont-weight: ${face.weight};\n\tfont-display: block;\n\tsrc: url(data:${face.mime};base64,${face.data}) format("${face.format}");\n}`,
		)
		.join("\n");
}
