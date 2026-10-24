import { describe, expect, it } from "vitest";
import {
	BRAND_ASSET_CONTENT_TYPES,
	BRAND_ASSET_EXTENSIONS,
	BRAND_ASSET_MAX_BYTES,
	BRAND_FONT_CONTENT_TYPES,
	brandAssetAcceptAttribute,
	checkBrandAssetFile,
	HERO_MAX_INPUT_PIXELS,
	HERO_MAX_OUTPUT_EDGE,
	isBrandAssetContentType,
	sniffFontFormat,
	validateFontFile,
} from "../lib/brand-assets";

const KIB = 1024;
const MIB = 1024 * KIB;

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from([...values, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function ascii(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** A WOFF2 `UIntBase128`: seven bits a byte, most significant first. */
function base128(value: number): number[] {
	const out = [value & 0x7f];
	for (
		let rest = Math.floor(value / 128);
		rest > 0;
		rest = Math.floor(rest / 128)
	) {
		out.unshift(0x80 | (rest & 0x7f));
	}
	return out;
}

/** The WOFF2 known-tag indices of cmap, head, hhea, hmtx, maxp, name, glyf and loca. */
const WOFF2_TABLES = [0, 1, 2, 3, 4, 5, 10, 11];

/** A table directory entry, untransformed: glyf and loca take version 3. */
function untransformed(tagIndex: number, length = 16): number[] {
	const version = tagIndex === 10 || tagIndex === 11 ? 0xc0 : 0;
	return [version | tagIndex, ...base128(length)];
}

/**
 * A WOFF2 file whose header describes it: one directory entry per table,
 * then `compressed` bytes of filler where the Brotli stream goes.
 */
function woff2(
	entries: number[][] = WOFF2_TABLES.map((index) => untransformed(index)),
	compressed = 16,
): Uint8Array {
	const directory = entries.flat();
	const size = 48 + directory.length + compressed;
	const file = new Uint8Array(size).fill(7);
	const view = new DataView(file.buffer);
	file.set(ascii("wOF2"));
	view.setUint32(4, 0x00010000);
	view.setUint32(8, size);
	view.setUint16(12, entries.length);
	view.setUint16(14, 0);
	view.setUint32(16, 1024);
	view.setUint32(20, compressed);
	file.set(directory, 48);
	return file;
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
];

/**
 * A TrueType file whose eight table records all point at its last 16 bytes,
 * one table carrying the `head` magic number.
 */
function trueType(tables = TRUETYPE_TABLES): Uint8Array {
	const directoryEnd = 12 + tables.length * 16;
	const file = new Uint8Array(directoryEnd + 16);
	const view = new DataView(file.buffer);
	view.setUint32(0, 0x00010000);
	view.setUint16(4, tables.length);
	tables.forEach((tag, index) => {
		const record = 12 + index * 16;
		file.set(ascii(tag), record);
		view.setUint32(record + 8, directoryEnd);
		view.setUint32(record + 12, 16);
	});
	view.setUint32(directoryEnd + 12, 0x5f0f3cf5);
	return file;
}

describe("brand asset vocabulary", () => {
	it("keeps the recipient logo's types and 5 MiB cap", () => {
		expect(BRAND_ASSET_CONTENT_TYPES.logo).toEqual([
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
		]);
		expect(BRAND_ASSET_MAX_BYTES.logo).toBe(5 * MIB);
	});

	it("takes a PNG, JPEG or WebP hero up to 10 MiB and 40 megapixels, stored at 2,400 px", () => {
		expect(BRAND_ASSET_CONTENT_TYPES.hero).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
		]);
		expect(BRAND_ASSET_MAX_BYTES.hero).toBe(10 * MIB);
		expect(HERO_MAX_INPUT_PIXELS).toBe(40_000_000);
		expect(HERO_MAX_OUTPUT_EDGE).toBe(2400);
	});

	it("takes a woff2 or ttf font up to 512 KiB, and nothing else", () => {
		expect(BRAND_ASSET_CONTENT_TYPES.font).toEqual([
			"font/woff2",
			"font/ttf",
		]);
		expect(BRAND_ASSET_EXTENSIONS.font).toEqual([".woff2", ".ttf"]);
		expect(BRAND_ASSET_MAX_BYTES.font).toBe(512 * KIB);
		expect(BRAND_FONT_CONTENT_TYPES).toEqual({
			woff2: "font/woff2",
			ttf: "font/ttf",
		});
	});

	it("builds each accept attribute from the same types and extensions the check admits", () => {
		expect(brandAssetAcceptAttribute("font")).toBe(
			"font/woff2,font/ttf,.woff2,.ttf",
		);
		expect(brandAssetAcceptAttribute("hero")).toBe(
			"image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp",
		);
		for (const kind of ["logo", "hero", "font"] as const) {
			for (const entry of brandAssetAcceptAttribute(kind).split(",")) {
				const file = entry.startsWith(".")
					? { type: "", size: 1, name: `file${entry}` }
					: { type: entry, size: 1, name: "file" };
				expect(checkBrandAssetFile(kind, file).ok).toBe(true);
			}
		}
	});

	it("recognizes only a kind's own content types", () => {
		expect(isBrandAssetContentType("hero", "image/webp")).toBe(true);
		expect(isBrandAssetContentType("hero", "image/gif")).toBe(false);
		expect(isBrandAssetContentType("font", "font/otf")).toBe(false);
		expect(isBrandAssetContentType("font", undefined)).toBe(false);
	});
});

describe("checkBrandAssetFile", () => {
	it("admits a file by its type and signs it for that type", () => {
		expect(
			checkBrandAssetFile("hero", {
				type: "image/jpeg",
				size: 2 * MIB,
				name: "cover.jpg",
			}),
		).toEqual({ ok: true, contentType: "image/jpeg" });
	});

	it("falls back to the extension when the file carries no type", () => {
		expect(
			checkBrandAssetFile("font", {
				type: "",
				size: 40 * KIB,
				name: "Display.WOFF2",
			}),
		).toEqual({ ok: true, contentType: "font/woff2" });
		expect(
			checkBrandAssetFile("font", {
				type: "application/octet-stream",
				size: 40 * KIB,
				name: "Body.ttf",
			}),
		).toEqual({ ok: true, contentType: "font/ttf" });
	});

	it("refuses an .otf font and an SVG hero as unsupported", () => {
		expect(
			checkBrandAssetFile("font", {
				type: "font/otf",
				size: 40 * KIB,
				name: "Display.otf",
			}),
		).toEqual({ ok: false, code: "unsupported" });
		expect(
			checkBrandAssetFile("hero", {
				type: "image/svg+xml",
				size: 4 * KIB,
				name: "cover.svg",
			}),
		).toEqual({ ok: false, code: "unsupported" });
		expect(
			checkBrandAssetFile("hero", {
				type: "image/gif",
				size: 4 * KIB,
				name: "cover.gif",
			}),
		).toEqual({ ok: false, code: "unsupported" });
	});

	it("refuses a 600 KiB font and a 12 MiB hero as too_large, before what they are", () => {
		expect(
			checkBrandAssetFile("font", {
				type: "font/woff2",
				size: 600 * KIB,
				name: "Display.woff2",
			}),
		).toEqual({ ok: false, code: "too_large" });
		expect(
			checkBrandAssetFile("hero", {
				type: "image/png",
				size: 12 * MIB,
				name: "cover.png",
			}),
		).toEqual({ ok: false, code: "too_large" });
		// The server reads the stored size before the bytes, so the browser
		// answers the same code for a file that is both.
		expect(
			checkBrandAssetFile("font", {
				type: "font/otf",
				size: 600 * KIB,
				name: "Display.otf",
			}),
		).toEqual({ ok: false, code: "too_large" });
	});

	it("admits a file at exactly its cap", () => {
		expect(
			checkBrandAssetFile("font", {
				type: "font/ttf",
				size: 512 * KIB,
				name: "Body.ttf",
			}).ok,
		).toBe(true);
	});
});

describe("sniffFontFormat", () => {
	it("reads woff2 and both TrueType signatures", () => {
		expect(sniffFontFormat(bytes(0x77, 0x4f, 0x46, 0x32))).toBe("woff2");
		expect(sniffFontFormat(bytes(0x00, 0x01, 0x00, 0x00))).toBe("ttf");
		expect(sniffFontFormat(ascii("true\0\0\0\0"))).toBe("ttf");
	});

	it("refuses OpenType CFF, a collection, WOFF 1, an SVG renamed .woff2 and short input", () => {
		expect(sniffFontFormat(ascii("OTTO\0\0\0\0"))).toBeNull();
		expect(sniffFontFormat(ascii("ttcf\0\0\0\0"))).toBeNull();
		expect(sniffFontFormat(ascii("wOFF\0\0\0\0"))).toBeNull();
		expect(
			sniffFontFormat(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')),
		).toBeNull();
		expect(sniffFontFormat(Uint8Array.from([0x77, 0x4f, 0x46]))).toBeNull();
		expect(sniffFontFormat(new Uint8Array())).toBeNull();
	});
});

describe("validateFontFile", () => {
	it("admits a WOFF2 header that describes the file and a complete TrueType directory", () => {
		expect(validateFontFile(woff2())).toBe("woff2");
		expect(validateFontFile(trueType())).toBe("ttf");
		const apple = trueType();
		apple.set(ascii("true"));
		expect(validateFontFile(apple)).toBe("ttf");
	});

	it("refuses a bare signature, which is all a sniff reads", () => {
		expect(sniffFontFormat(bytes(0x77, 0x4f, 0x46, 0x32))).toBe("woff2");
		expect(validateFontFile(bytes(0x77, 0x4f, 0x46, 0x32))).toBeNull();
		expect(validateFontFile(bytes(0x00, 0x01, 0x00, 0x00))).toBeNull();
	});

	it("refuses a WOFF2 file cut short, grown, or with a header that does not fit it", () => {
		const file = woff2();
		expect(validateFontFile(file.subarray(0, 60))).toBeNull();
		expect(validateFontFile(Uint8Array.from([...file, 0]))).toBeNull();
		expect(validateFontFile(file.subarray(0, 48))).toBeNull();

		const noTables = woff2();
		new DataView(noTables.buffer).setUint16(12, 0);
		expect(validateFontFile(noTables)).toBeNull();

		const reserved = woff2();
		new DataView(reserved.buffer).setUint16(14, 1);
		expect(validateFontFile(reserved)).toBeNull();

		const overflowing = woff2();
		new DataView(overflowing.buffer).setUint32(20, 64);
		expect(validateFontFile(overflowing)).toBeNull();
	});

	it("reads the table directory: transformed lengths, custom tags, and every table a font needs", () => {
		const transformedGlyf = WOFF2_TABLES.map((index) =>
			index === 10
				? [10, ...base128(64), ...base128(16)]
				: untransformed(index),
		);
		expect(validateFontFile(woff2(transformedGlyf))).toBe("woff2");
		const customTag = [
			...WOFF2_TABLES.map((index) => untransformed(index)),
			[63, ...ascii("ZZZZ"), ...base128(16)],
		];
		expect(validateFontFile(woff2(customTag))).toBe("woff2");

		const noGlyf = WOFF2_TABLES.filter((index) => index !== 10).map(
			(index) => untransformed(index),
		);
		expect(validateFontFile(woff2(noGlyf))).toBeNull();
		const leadingZero = [
			[0, 0x80, 0x10],
			...WOFF2_TABLES.slice(1).map((index) => untransformed(index)),
		];
		expect(validateFontFile(woff2(leadingZero))).toBeNull();
	});

	it("refuses a collection and sizes a decoder could not allocate safely", () => {
		const collection = woff2();
		collection.set(ascii("ttcf"), 4);
		expect(validateFontFile(collection)).toBeNull();

		const largeSfnt = woff2();
		new DataView(largeSfnt.buffer).setUint32(16, 4 * MIB + 1);
		expect(validateFontFile(largeSfnt)).toBeNull();

		const largeTables = [
			...WOFF2_TABLES.map((index) => untransformed(index)),
			untransformed(6, 4 * MIB),
		];
		expect(validateFontFile(woff2(largeTables))).toBeNull();
		const largeLength = [
			...WOFF2_TABLES.map((index) => untransformed(index)),
			[6, 0x8f, 0xff, 0xff, 0xff, 0x7f],
		];
		expect(validateFontFile(woff2(largeLength))).toBeNull();
	});

	it("refuses a TrueType file cut short, missing a table, pointing past its end or without the head magic", () => {
		const file = trueType();
		expect(validateFontFile(file.subarray(0, 100))).toBeNull();
		expect(validateFontFile(file.subarray(0, file.length - 1))).toBeNull();
		expect(
			validateFontFile(
				trueType(TRUETYPE_TABLES.filter((t) => t !== "glyf")),
			),
		).toBeNull();

		const pastEnd = trueType();
		new DataView(pastEnd.buffer).setUint32(12 + 8, pastEnd.length);
		expect(validateFontFile(pastEnd)).toBeNull();

		const insideDirectory = trueType();
		new DataView(insideDirectory.buffer).setUint32(12 + 8, 0);
		expect(validateFontFile(insideDirectory)).toBeNull();

		const noMagic = trueType();
		noMagic.fill(0, noMagic.length - 4);
		expect(validateFontFile(noMagic)).toBeNull();
	});

	it("refuses what the sniff refuses", () => {
		expect(validateFontFile(ascii("OTTO\0\0\0\0"))).toBeNull();
		expect(validateFontFile(new Uint8Array())).toBeNull();
	});
});
