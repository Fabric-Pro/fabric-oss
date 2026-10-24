/**
 * Font files for the suites that upload or serve a Brand kit font.
 *
 * Real fonts decode: Inter is the export's own font, read where it is checked
 * in; Geist is copied next to this file under its SIL Open Font License
 * (`fonts/LICENSE.txt`). Forged fonts hold together as containers, so they
 * pass the structural check, and then fail to decode: a WOFF2 header and
 * table directory over bytes that are no Brotli stream, and a TrueType table
 * directory whose eight tables all point at one 16-byte table.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INTER_WOFF2 = fileURLToPath(
	new URL(
		"../../../temporal/src/lib/proposal-export/fonts/Inter-Regular.woff2",
		import.meta.url,
	),
);
const GEIST_TTF = fileURLToPath(
	new URL("./fonts/Geist-Regular.ttf", import.meta.url),
);

/** Inter Regular as WOFF2 (about 109 KB). */
export function realWoff2(): Buffer {
	return readFileSync(INTER_WOFF2);
}

/**
 * Geist Regular as TrueType (about 126 KB), padded with trailing zeros to
 * `size` when given: the table directory still fits, and a decoder ignores
 * bytes past the last table.
 */
export function realTrueType(size?: number): Buffer {
	const font = readFileSync(GEIST_TTF);
	return size && size > font.length
		? Buffer.concat([font, Buffer.alloc(size - font.length)])
		: font;
}

const WOFF2_HEADER_BYTES = 48;
/** The WOFF2 known-tag indices of cmap, head, hhea, hmtx, maxp, name, glyf, loca. */
const WOFF2_REQUIRED_TAG_INDICES = [0, 1, 2, 3, 4, 5, 10, 11];
const FORGED_TABLE_BYTES = 16;

/**
 * A WOFF2 file whose header describes it and whose table directory names
 * every table a font needs, untransformed, 16 bytes each, over 16 bytes of
 * filler where the Brotli stream should be.
 */
export function forgedWoff2(): Buffer {
	const directory = WOFF2_REQUIRED_TAG_INDICES.flatMap((index) => [
		index === 10 || index === 11 ? 0xc0 | index : index,
		FORGED_TABLE_BYTES,
	]);
	const size = WOFF2_HEADER_BYTES + directory.length + FORGED_TABLE_BYTES;
	const bytes = Buffer.alloc(size, 7);
	bytes.write("wOF2", 0, "latin1");
	bytes.writeUInt32BE(0x00010000, 4);
	bytes.writeUInt32BE(size, 8);
	bytes.writeUInt16BE(WOFF2_REQUIRED_TAG_INDICES.length, 12);
	bytes.writeUInt16BE(0, 14);
	bytes.writeUInt32BE(
		12 + WOFF2_REQUIRED_TAG_INDICES.length * (16 + FORGED_TABLE_BYTES),
		16,
	);
	bytes.writeUInt32BE(FORGED_TABLE_BYTES, 20);
	Buffer.from(directory).copy(bytes, WOFF2_HEADER_BYTES);
	return bytes;
}

const TRUETYPE_TABLES = [
	"cmap",
	"glyf",
	"head",
	"hhea",
	"hmtx",
	"loca",
	"maxp",
	"name",
] as const;
const TRUETYPE_DIRECTORY_END = 12 + TRUETYPE_TABLES.length * 16;
const HEAD_MAGIC = 0x5f0f3cf5;

/**
 * A TrueType file of 156 bytes: eight table records that all point at its
 * last 16 bytes, which carry the `head` magic number and nothing a decoder
 * can read as a font.
 */
export function forgedTrueType(): Buffer {
	const bytes = Buffer.alloc(TRUETYPE_DIRECTORY_END + FORGED_TABLE_BYTES);
	bytes.writeUInt32BE(0x00010000, 0);
	bytes.writeUInt16BE(TRUETYPE_TABLES.length, 4);
	TRUETYPE_TABLES.forEach((tag, index) => {
		const record = 12 + index * 16;
		bytes.write(tag, record, "latin1");
		bytes.writeUInt32BE(TRUETYPE_DIRECTORY_END, record + 8);
		bytes.writeUInt32BE(FORGED_TABLE_BYTES, record + 12);
	});
	bytes.writeUInt32BE(HEAD_MAGIC, TRUETYPE_DIRECTORY_END + 12);
	return bytes;
}
