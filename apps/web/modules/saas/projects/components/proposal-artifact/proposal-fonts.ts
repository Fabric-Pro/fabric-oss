import { JetBrains_Mono, Poppins } from "next/font/google";

/*
 * The Proposal theme's display and mono faces on the live page (Fizzy
 * #2946): the same Poppins and JetBrains Mono that print embeds from
 * committed files, here served by next/font from the app's own origin. The
 * body face, Inter, is the app's own (`--font-inter`, Document.tsx).
 *
 * next/font registers each under a hashed family name, so the theme reaches
 * them through these custom properties, which its fallback stacks name
 * ahead of the literal family. The classes go on the theme root only, and
 * nothing is preloaded: an editor that never wears the theme fetches neither.
 */
const displayFont = Poppins({
	weight: "700",
	subsets: ["latin"],
	variable: "--font-poppins",
	display: "swap",
	preload: false,
});

const monoFont = JetBrains_Mono({
	weight: ["400", "500"],
	subsets: ["latin"],
	variable: "--font-jetbrains-mono",
	display: "swap",
	preload: false,
});

/** The classes that define `--font-poppins` and `--font-jetbrains-mono`. */
export const PROPOSAL_FONT_VARIABLES = `${displayFont.variable} ${monoFont.variable}`;
