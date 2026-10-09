/**
 * The Glossy edition's color palette (Fizzy #2589).
 *
 * Lives in `@repo/utils/glossy/visual-colors` so the worker that fills a
 * Proposal's visuals and the browser that renders a Glossy edition derive
 * the same palette (Fizzy #2801); re-exported here for the web modules that
 * import it from this path.
 */

export {
	chosenBrandColor,
	deriveGlossyPalette,
	type GlossyPalette,
	type GlossyPaletteInput,
	glossyMermaidThemeVariables,
	NEUTRAL_GLOSSY_COLORS,
	strictHexColor,
} from "@repo/utils/glossy/visual-colors";
