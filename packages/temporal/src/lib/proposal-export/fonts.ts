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
 * Chromium load it before it lays the boxes out). Only the weights the theme
 * sets: Poppins 700 for headings, Inter 400/600/700/800 for body, labels,
 * bold and the title, JetBrains Mono 400/500 for the mono role.
 *
 * Until Chromium runs sandboxed or in a container without secrets, print
 * never embeds an uploaded brand font: the committed files are the only font
 * bytes a print page carries.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * whatever the Brand kit names, since print never embeds an uploaded or
 * brand font yet. A brand-font organization therefore prints Poppins for
 * display. The page applies it before the paint is resolved, and the
 * export's brand record before it hashes what printed.
 */
export function printTokensOf<TAsset>(
	tokens: ProposalThemeTokens<TAsset>,
): ProposalThemeTokens<TAsset> {
	const committed = (value: string) =>
		({ value, source: "DEFAULT" }) as const;
	return {
		...tokens,
		proposer: {
			...tokens.proposer,
			fonts: {
				display: committed(PRINT_FONTS.display),
				body: committed(PRINT_FONTS.body),
				mono: committed(PRINT_FONTS.mono),
			},
		},
	};
}

const FONT_DIR = join(__dirname, "fonts");

/** The MIME type and `format()` hint for each kind of file committed. */
const FONT_FORMATS = {
	woff2: { mime: "font/woff2", format: "woff2" },
	ttf: { mime: "font/ttf", format: "truetype" },
} as const;

interface PrintFace {
	family: string;
	weight: number;
	file: string;
	kind: keyof typeof FONT_FORMATS;
}

/** Every face a print page embeds. Upstream ships Poppins as TTF only. */
const PRINT_FACES: readonly PrintFace[] = [
	{
		family: PRINT_FONTS.display,
		weight: 700,
		file: "Poppins-Bold.ttf",
		kind: "ttf",
	},
	{
		family: PRINT_FONTS.body,
		weight: 400,
		file: "Inter-Regular.woff2",
		kind: "woff2",
	},
	{
		family: PRINT_FONTS.body,
		weight: 600,
		file: "Inter-SemiBold.woff2",
		kind: "woff2",
	},
	{
		family: PRINT_FONTS.body,
		weight: 700,
		file: "Inter-Bold.woff2",
		kind: "woff2",
	},
	{
		family: PRINT_FONTS.body,
		weight: 800,
		file: "Inter-ExtraBold.woff2",
		kind: "woff2",
	},
	{
		family: PRINT_FONTS.mono,
		weight: 400,
		file: "JetBrainsMono-Regular.woff2",
		kind: "woff2",
	},
	{
		family: PRINT_FONTS.mono,
		weight: 500,
		file: "JetBrainsMono-Medium.woff2",
		kind: "woff2",
	},
];

let fontFaceCss: string | null = null;

/**
 * `@font-face` rules for every embedded face, read once per worker process.
 * `font-display: block` so nothing prints in a fallback font while the data
 * URL decodes.
 */
export function printFontFaceCss(): string {
	if (fontFaceCss === null) {
		fontFaceCss = PRINT_FACES.map(({ family, weight, file, kind }) => {
			const { mime, format } = FONT_FORMATS[kind];
			const data = readFileSync(join(FONT_DIR, file)).toString("base64");
			return [
				"@font-face {",
				`\tfont-family: "${family}";`,
				"\tfont-style: normal;",
				`\tfont-weight: ${weight};`,
				"\tfont-display: block;",
				`\tsrc: url(data:${mime};base64,${data}) format("${format}");`,
				"}",
			].join("\n");
		}).join("\n");
	}
	return fontFaceCss;
}
