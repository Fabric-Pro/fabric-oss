/**
 * The one font the Proposal export prints with (Fizzy #2946): Inter 4.1 from
 * the rsms/inter release, under the SIL Open Font License (`fonts/LICENSE.txt`,
 * and an entry in THIRD_PARTY_NOTICES.md).
 *
 * Embedded as base64 `@font-face` rules, so the print page loads nothing and
 * the margin boxes find the font too (it is also the body font, which makes
 * Chromium load it before it lays the boxes out). Four weights cover every
 * weight the theme sets: body 400, labels 600, headings 700, the title 800.
 *
 * Until Chromium runs sandboxed or in a container without secrets, print
 * never embeds an uploaded brand font: the committed Inter is the only font
 * bytes a print page carries.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";

/** The family name the print page and the diagrams are set in. */
export const PRINT_FONT_FAMILY = "Inter";

/**
 * The tokens as print sets them: every font token is Inter, whatever the
 * Brand kit names, since print never embeds an uploaded or brand font yet.
 * The page applies it before the paint is resolved, and the export's brand
 * record before it hashes what printed.
 */
export function printTokensOf<TAsset>(
	tokens: ProposalThemeTokens<TAsset>,
): ProposalThemeTokens<TAsset> {
	const inter = { value: PRINT_FONT_FAMILY, source: "DEFAULT" } as const;
	return {
		...tokens,
		proposer: {
			...tokens.proposer,
			fonts: { display: inter, body: inter, mono: inter },
		},
	};
}

const FONT_DIR = join(__dirname, "fonts");

const INTER_FACES = [
	{ weight: 400, file: "Inter-Regular.woff2" },
	{ weight: 600, file: "Inter-SemiBold.woff2" },
	{ weight: 700, file: "Inter-Bold.woff2" },
	{ weight: 800, file: "Inter-ExtraBold.woff2" },
] as const;

let fontFaceCss: string | null = null;

/**
 * `@font-face` rules for every embedded Inter weight, read once per worker
 * process. `font-display: block` so nothing prints in a fallback font while
 * the data URL decodes.
 */
export function interFontFaceCss(): string {
	if (fontFaceCss === null) {
		fontFaceCss = INTER_FACES.map(({ weight, file }) => {
			const data = readFileSync(join(FONT_DIR, file)).toString("base64");
			return [
				"@font-face {",
				`\tfont-family: "${PRINT_FONT_FAMILY}";`,
				"\tfont-style: normal;",
				`\tfont-weight: ${weight};`,
				"\tfont-display: block;",
				`\tsrc: url(data:font/woff2;base64,${data}) format("woff2");`,
				"}",
			].join("\n");
		}).join("\n");
	}
	return fontFaceCss;
}
