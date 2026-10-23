/**
 * The upload vocabulary of the brand surfaces (Fizzy #2946): which files the
 * recipient logo, the Brand kit hero and the Brand kit fonts accept, how
 * large they may be, and the code a refused file answers with.
 *
 * The picker's `accept` attribute, the browser's pre-check, the signed PUT
 * and the server's promotion all read this one module, so a picker never
 * offers a file its gate then refuses, and the code the browser shows is the
 * code the server answers with. The server still checks the bytes: a type or
 * an extension is only what the file claims to be.
 *
 * Pure data and functions only: the browser bundle imports this module.
 */

export type BrandAssetKind = "logo" | "hero" | "font";

/** Every reason an upload is refused, in the browser and on the server. */
export const BRAND_ASSET_REJECTION_CODES = [
	"too_large",
	"unsupported",
] as const;
export type BrandAssetRejectionCode =
	(typeof BRAND_ASSET_REJECTION_CODES)[number];

const MIB = 1024 * 1024;

/**
 * The content types each kind is signed for, and the extension each one is
 * known by when a picked file carries no type (paste and drop often do not).
 */
const VOCABULARY = {
	logo: {
		contentTypes: {
			"image/png": [".png"],
			"image/jpeg": [".jpg", ".jpeg"],
			"image/gif": [".gif"],
			"image/webp": [".webp"],
		},
		maxBytes: 5 * MIB,
	},
	hero: {
		contentTypes: {
			"image/png": [".png"],
			"image/jpeg": [".jpg", ".jpeg"],
			"image/webp": [".webp"],
		},
		maxBytes: 10 * MIB,
	},
	font: {
		contentTypes: {
			"font/woff2": [".woff2"],
			"font/ttf": [".ttf"],
		},
		maxBytes: 512 * 1024,
	},
} as const;

type ContentTypesOf<K extends BrandAssetKind> = Extract<
	keyof (typeof VOCABULARY)[K]["contentTypes"],
	string
>;

export type LogoUploadContentType = ContentTypesOf<"logo">;
export type HeroUploadContentType = ContentTypesOf<"hero">;
export type FontUploadContentType = ContentTypesOf<"font">;
export type BrandAssetContentType =
	| LogoUploadContentType
	| HeroUploadContentType
	| FontUploadContentType;

function contentTypesOf<K extends BrandAssetKind>(
	kind: K,
): readonly ContentTypesOf<K>[] {
	return Object.keys(VOCABULARY[kind].contentTypes) as ContentTypesOf<K>[];
}

export const LOGO_UPLOAD_CONTENT_TYPES = contentTypesOf("logo");
export const HERO_UPLOAD_CONTENT_TYPES = contentTypesOf("hero");
export const FONT_UPLOAD_CONTENT_TYPES = contentTypesOf("font");

/** The content types each kind's signed PUT accepts. */
export const BRAND_ASSET_CONTENT_TYPES: {
	readonly [K in BrandAssetKind]: readonly ContentTypesOf<K>[];
} = {
	logo: LOGO_UPLOAD_CONTENT_TYPES,
	hero: HERO_UPLOAD_CONTENT_TYPES,
	font: FONT_UPLOAD_CONTENT_TYPES,
};

/** The extensions each kind accepts, lowercase with their dot. */
export const BRAND_ASSET_EXTENSIONS: {
	readonly [K in BrandAssetKind]: readonly string[];
} = {
	logo: Object.values(VOCABULARY.logo.contentTypes).flat(),
	hero: Object.values(VOCABULARY.hero.contentTypes).flat(),
	font: Object.values(VOCABULARY.font.contentTypes).flat(),
};

/** The most bytes each kind may be signed for, and stored with. */
export const BRAND_ASSET_MAX_BYTES: { readonly [K in BrandAssetKind]: number } =
	{
		logo: VOCABULARY.logo.maxBytes,
		hero: VOCABULARY.hero.maxBytes,
		font: VOCABULARY.font.maxBytes,
	};

/** A hero larger than this many pixels is refused before it is decoded. */
export const HERO_MAX_INPUT_PIXELS = 40_000_000;

/** A hero is stored with its longest edge at most this many pixels. */
export const HERO_MAX_OUTPUT_EDGE = 2400;

/** The font formats a Brand kit stores, by what their bytes say. */
export type BrandFontFormat = "woff2" | "ttf";

/** The content type a font of each format is stored and served with. */
export const BRAND_FONT_CONTENT_TYPES: {
	readonly [F in BrandFontFormat]: FontUploadContentType;
} = {
	woff2: "font/woff2",
	ttf: "font/ttf",
};

/** The `accept` attribute of a kind's file input. */
export function brandAssetAcceptAttribute(kind: BrandAssetKind): string {
	return [
		...BRAND_ASSET_CONTENT_TYPES[kind],
		...BRAND_ASSET_EXTENSIONS[kind],
	].join(",");
}

/** Whether `contentType` is one a kind's signed PUT accepts. */
export function isBrandAssetContentType<K extends BrandAssetKind>(
	kind: K,
	contentType: unknown,
): contentType is ContentTypesOf<K> {
	return (BRAND_ASSET_CONTENT_TYPES[kind] as readonly unknown[]).includes(
		contentType,
	);
}

function contentTypeForName<K extends BrandAssetKind>(
	kind: K,
	name: string,
): ContentTypesOf<K> | null {
	const lower = name.trim().toLowerCase();
	const entries = Object.entries(VOCABULARY[kind].contentTypes) as [
		ContentTypesOf<K>,
		readonly string[],
	][];
	for (const [contentType, extensions] of entries) {
		if (extensions.some((extension) => lower.endsWith(extension))) {
			return contentType;
		}
	}
	return null;
}

export type BrandAssetFileCheck<K extends BrandAssetKind = BrandAssetKind> =
	| { ok: true; contentType: ContentTypesOf<K> }
	| { ok: false; code: BrandAssetRejectionCode };

/**
 * The browser's pre-check of a picked file, in the order the server checks
 * a stored upload: its size first, then what it is. A file is admitted when
 * its type is one of the kind's, or, failing that, when its name ends in one
 * of the kind's extensions; `contentType` is what the upload is signed for.
 */
export function checkBrandAssetFile<K extends BrandAssetKind>(
	kind: K,
	file: { type: string; size: number; name: string },
): BrandAssetFileCheck<K> {
	if (file.size > BRAND_ASSET_MAX_BYTES[kind]) {
		return { ok: false, code: "too_large" };
	}
	if (isBrandAssetContentType(kind, file.type)) {
		return { ok: true, contentType: file.type };
	}
	const byName = contentTypeForName(kind, file.name);
	return byName
		? { ok: true, contentType: byName }
		: { ok: false, code: "unsupported" };
}

/**
 * A font's format from its leading bytes: `wOF2` is WOFF2, and `00 01 00 00`
 * or `true` is TrueType. Anything else (OpenType CFF's `OTTO`, a collection,
 * an SVG or an HTML page with a font's name) is null.
 */
export function sniffFontFormat(bytes: Uint8Array): BrandFontFormat | null {
	if (bytes.length < 4) {
		return null;
	}
	const [a, b, c, d] = bytes;
	if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x32) {
		return "woff2";
	}
	if (
		(a === 0x00 && b === 0x01 && c === 0x00 && d === 0x00) ||
		(a === 0x74 && b === 0x72 && c === 0x75 && d === 0x65)
	) {
		return "ttf";
	}
	return null;
}

/** Most tables a font may declare before its file reads as malformed. */
const FONT_MAX_TABLES = 1024;
/** The tables every TrueType font needs to be drawn at all. */
const TRUETYPE_REQUIRED_TABLES = [
	"cmap",
	"glyf",
	"head",
	"hhea",
	"hmtx",
	"loca",
	"maxp",
	"name",
] as const;
const WOFF2_HEADER_BYTES = 48;
const SFNT_HEADER_BYTES = 12;
const SFNT_TABLE_RECORD_BYTES = 16;
const HEAD_MAGIC = 0x5f0f3cf5;

function tagAt(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}

/**
 * The most a WOFF2 file may decompress to. A decoder allocates what the table
 * directory declares before it reads a byte of the compressed stream, so the
 * declared sizes are bounded here, before any decoder sees the file.
 */
const WOFF2_MAX_DECODED_BYTES = 8 * VOCABULARY.font.maxBytes;
/** The WOFF2 known-tag indices of the tables a TrueType font needs. */
const WOFF2_REQUIRED_TAG_INDICES = [0, 1, 2, 3, 4, 5, 10, 11] as const;
const WOFF2_GLYF_TAG_INDEX = 10;
const WOFF2_LOCA_TAG_INDEX = 11;
const WOFF2_CUSTOM_TAG_INDEX = 63;
const WOFF2_COLLECTION_FLAVOR = 0x74746366;

/**
 * A WOFF2 `UIntBase128` at `offset`: the value and the offset after it, or
 * null when it runs past the end, carries a leading zero or exceeds 32 bits.
 */
function readUIntBase128(
	view: DataView,
	offset: number,
): { value: number; next: number } | null {
	let value = 0;
	for (let index = 0; index < 5; index++) {
		if (offset + index >= view.byteLength) {
			return null;
		}
		const byte = view.getUint8(offset + index);
		if (index === 0 && byte === 0x80) {
			return null;
		}
		if (value > 0x1ffffff) {
			return null;
		}
		value = value * 128 + (byte & 0x7f);
		if ((byte & 0x80) === 0) {
			return { value, next: offset + index + 1 };
		}
	}
	return null;
}

/**
 * Whether a WOFF2 file's header and table directory describe this very file:
 * its declared length is the byte length, its reserved field is zero, it is a
 * single font rather than a collection, its table directory parses and names
 * every table a TrueType font needs, the sizes it declares stay within
 * {@link WOFF2_MAX_DECODED_BYTES}, and its compressed data fits inside the
 * file. Decompressing is left to the server's decoder and the browser.
 */
function isWellFormedWoff2(bytes: Uint8Array): boolean {
	if (bytes.length <= WOFF2_HEADER_BYTES) {
		return false;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const flavor = view.getUint32(4);
	const length = view.getUint32(8);
	const numTables = view.getUint16(12);
	const reserved = view.getUint16(14);
	const totalSfntSize = view.getUint32(16);
	const totalCompressedSize = view.getUint32(20);
	if (
		flavor === WOFF2_COLLECTION_FLAVOR ||
		length !== bytes.length ||
		numTables < 1 ||
		numTables > FONT_MAX_TABLES ||
		reserved !== 0 ||
		totalSfntSize === 0 ||
		totalSfntSize > WOFF2_MAX_DECODED_BYTES ||
		totalCompressedSize === 0
	) {
		return false;
	}
	const tagIndices = new Set<number>();
	let decodedBytes = 0;
	let offset = WOFF2_HEADER_BYTES;
	for (let table = 0; table < numTables; table++) {
		if (offset >= bytes.length) {
			return false;
		}
		const flags = view.getUint8(offset);
		const tagIndex = flags & 0x3f;
		const transformVersion = flags >> 6;
		offset += tagIndex === WOFF2_CUSTOM_TAG_INDEX ? 5 : 1;
		const origLength = readUIntBase128(view, offset);
		if (!origLength) {
			return false;
		}
		offset = origLength.next;
		let tableBytes = origLength.value;
		// glyf and loca are transformed unless their version is 3 (null);
		// every other table is transformed unless its version is 0.
		const isGlyfOrLoca =
			tagIndex === WOFF2_GLYF_TAG_INDEX ||
			tagIndex === WOFF2_LOCA_TAG_INDEX;
		if (isGlyfOrLoca ? transformVersion !== 3 : transformVersion !== 0) {
			const transformLength = readUIntBase128(view, offset);
			if (!transformLength) {
				return false;
			}
			offset = transformLength.next;
			tableBytes = transformLength.value;
		}
		decodedBytes += tableBytes;
		if (decodedBytes > WOFF2_MAX_DECODED_BYTES) {
			return false;
		}
		tagIndices.add(tagIndex);
	}
	return (
		WOFF2_REQUIRED_TAG_INDICES.every((index) => tagIndices.has(index)) &&
		offset + totalCompressedSize <= bytes.length
	);
}

/**
 * Whether a TrueType file's table directory fits the file and names the
 * tables a font needs to be drawn, with a `head` table that carries its
 * magic number. Glyph data itself is left to the browser's font sanitizer.
 */
function isWellFormedTrueType(bytes: Uint8Array): boolean {
	if (bytes.length < SFNT_HEADER_BYTES) {
		return false;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = view.getUint16(4);
	const directoryEnd =
		SFNT_HEADER_BYTES + numTables * SFNT_TABLE_RECORD_BYTES;
	if (
		numTables < TRUETYPE_REQUIRED_TABLES.length ||
		numTables > FONT_MAX_TABLES ||
		directoryEnd > bytes.length
	) {
		return false;
	}
	const tables = new Map<string, { offset: number; length: number }>();
	for (let index = 0; index < numTables; index++) {
		const record = SFNT_HEADER_BYTES + index * SFNT_TABLE_RECORD_BYTES;
		const offset = view.getUint32(record + 8);
		const length = view.getUint32(record + 12);
		if (offset < directoryEnd || offset + length > bytes.length) {
			return false;
		}
		tables.set(tagAt(view, record), { offset, length });
	}
	if (!TRUETYPE_REQUIRED_TABLES.every((tag) => tables.has(tag))) {
		return false;
	}
	const head = tables.get("head");
	return (
		head !== undefined &&
		head.length >= 16 &&
		view.getUint32(head.offset + 12) === HEAD_MAGIC
	);
}

/**
 * The format of a font file whose structure holds together, or null: the
 * magic bytes of {@link sniffFontFormat} and then the format's own header and
 * table directory. A file that only starts with the right four bytes is
 * refused. This bounds what a decoder may be asked to allocate; the server
 * still decodes the tables before it stores or serves a font.
 */
export function validateFontFile(bytes: Uint8Array): BrandFontFormat | null {
	const format = sniffFontFormat(bytes);
	if (format === "woff2") {
		return isWellFormedWoff2(bytes) ? "woff2" : null;
	}
	if (format === "ttf") {
		return isWellFormedTrueType(bytes) ? "ttf" : null;
	}
	return null;
}
