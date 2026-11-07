/**
 * The three faces the Proposal export prints with (Fizzy #2946), each under
 * the SIL Open Font License with its own license file in `fonts/` and an
 * entry in THIRD_PARTY_NOTICES.md:
 *
 * - display: Poppins 4.003 from google/fonts (`OFL-Poppins.txt`);
 * - body: Inter 4.1 from the rsms/inter release (`LICENSE.txt`);
 * - mono: JetBrains Mono 2.200 from JetBrains/JetBrainsMono
 *   (`OFL-JetBrainsMono.txt`).
 *
 * Embedded as base64 `@font-face` rules, so the print page loads nothing and
 * the margin boxes find their font too (Inter is the body font, which makes
 * Chromium load it before it lays the boxes out). The bundled catalog covers
 * regular body, semibold labels and bold headings for every selectable family.
 * Preview and print consume the same generated committed bytes.
 *
 * Until Chromium runs sandboxed or in a container without secrets, print
 * never embeds an uploaded brand font: the committed files are the only font
 * bytes a print page carries.
 */

import { artifactBrandFontFaceCss } from "@repo/utils/artifact-brand-fonts";
import { isArtifactFontFamily } from "@repo/utils/artifact-brand-theme";
import {
	NEUTRAL_THEME,
	type ProposalThemeTokens,
} from "@repo/utils/proposal-artifact/theme-tokens";

/**
 * The family each role prints in: the neutral theme's own, so the
 * `@font-face` names match the `--pa-font-*` properties byte for byte. The
 * margin boxes and the diagrams are set in the body family.
 */
export const PRINT_FONTS = NEUTRAL_THEME.fonts;

/**
 * The tokens as print sets them: each font role in its committed family,
 * with a neutral fallback for unsupported families. Only bundled families
 * can be embedded; uploaded font bytes remain excluded. The page applies it before the paint is resolved, and the
 * export's brand record before it hashes what printed.
 */
export function printTokensOf<TAsset>(
	tokens: ProposalThemeTokens<TAsset>,
): ProposalThemeTokens<TAsset> {
	const committed = (value: string, fallback: string) =>
		isArtifactFontFamily(value)
			? { value, source: "MANUAL" as const }
			: { value: fallback, source: "DEFAULT" as const };
	return {
		...tokens,
		proposer: {
			...tokens.proposer,
			fonts: {
				display: committed(
					tokens.proposer.fonts.display.value,
					PRINT_FONTS.display,
				),
				body: committed(
					tokens.proposer.fonts.body.value,
					PRINT_FONTS.body,
				),
				mono: committed(
					tokens.proposer.fonts.mono.value,
					PRINT_FONTS.mono,
				),
			},
		},
	};
}

/** All bytes are generated from committed licensed files; uploaded fonts stay excluded. */
export function printFontFaceCss(fonts?: {
	displayFontFamily?: string;
	bodyFontFamily?: string;
}): string {
	return artifactBrandFontFaceCss(fonts);
}
