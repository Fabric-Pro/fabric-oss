import {
	type BrandFontFormat,
	validateFontFile,
} from "@repo/utils/brand-assets";
import { create, type Font, type FontCollection } from "fontkit";

const DECODED_TYPE: Record<BrandFontFormat, Font["type"]> = {
	woff2: "WOFF2",
	ttf: "TTF",
};
/** The em sizes the TrueType specification allows. */
const MIN_UNITS_PER_EM = 16;
const MAX_UNITS_PER_EM = 16384;
/** A Latin capital most brand fonts map; a font without it maps `.notdef`. */
const PROBE_CODE_POINT = 0x41;

function isSingleFont(font: Font | FontCollection): font is Font {
	return font.type !== "TTC" && font.type !== "DFont";
}

/**
 * The format of a Brand kit font that decodes, or null (Fizzy #2946).
 *
 * First {@link validateFontFile}: the container's structure, which also
 * bounds what WOFF2 decompression may allocate. Then the font is decoded the
 * way a renderer reads it: the WOFF2 stream is decompressed and its glyph
 * table rebuilt, the `head`, `maxp` and `cmap` tables are read, every glyph's
 * record is located in `glyf` through `loca`, and a mapped glyph's advance is
 * read from `hmtx`. A file that only looks like a font fails here, so it is
 * never stored, advertised in the theme tokens or served to a page.
 *
 * Glyph outlines are not composed: a composite glyph that repeats its
 * components can grow exponentially, and the browser's font sanitizer still
 * reads every outline before it draws one.
 */
export function decodeBrandFont(bytes: Uint8Array): BrandFontFormat | null {
	const format = validateFontFile(bytes);
	if (!format) {
		return null;
	}
	try {
		const font = create(
			Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		);
		if (
			!isSingleFont(font) ||
			font.type !== DECODED_TYPE[format] ||
			font.numGlyphs < 1 ||
			font.unitsPerEm < MIN_UNITS_PER_EM ||
			font.unitsPerEm > MAX_UNITS_PER_EM
		) {
			return null;
		}
		for (let glyphId = 0; glyphId < font.numGlyphs; glyphId++) {
			font.getGlyph(glyphId).cbox;
		}
		const advance = font.glyphForCodePoint(PROBE_CODE_POINT).advanceWidth;
		return Number.isFinite(advance) ? format : null;
	} catch {
		return null;
	}
}
