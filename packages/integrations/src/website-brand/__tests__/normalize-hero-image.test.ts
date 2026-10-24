import { crc32 } from "node:zlib";
import {
	BRAND_ASSET_MAX_BYTES,
	HERO_MAX_OUTPUT_EDGE,
} from "@repo/utils/brand-assets";
import sharp, { type Color, type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
	LOGO_MAX_INPUT_BYTES,
	normalizeHeroImage,
	sniffLogoFormat,
} from "../normalize-logo";

function solid(
	width: number,
	height: number,
	background: Color,
	channels: 3 | 4 = 4,
): Sharp {
	return sharp({ create: { width, height, channels, background } });
}

/** A valid PNG whose header claims `width` x `height` (IHDR CRC fixed up). */
async function pngDeclaring(width: number, height: number): Promise<Buffer> {
	const png = Buffer.from(await solid(2, 2, "#1d4ed8").png().toBuffer());
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
	return png;
}

describe("normalizeHeroImage", () => {
	it("re-encodes an opaque source as JPEG", async () => {
		const result = await normalizeHeroImage(
			await solid(40, 20, "#0d9488", 3).png().toBuffer(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.format).toBe("jpeg");
		expect(sniffLogoFormat(result.bytes)).toBe("jpeg");
		expect([result.width, result.height]).toEqual([40, 20]);
	});

	it("keeps a source with an alpha channel as PNG", async () => {
		const result = await normalizeHeroImage(
			await solid(16, 16, { r: 13, g: 148, b: 136, alpha: 0.5 })
				.png()
				.toBuffer(),
		);
		expect(result.ok && result.format).toBe("png");
		expect(result.ok && sniffLogoFormat(result.bytes)).toBe("png");
	});

	it("takes JPEG and WebP sources", async () => {
		const base = solid(12, 12, "#1d4ed8", 3);
		for (const bytes of [
			await base.clone().jpeg().toBuffer(),
			await base.clone().webp().toBuffer(),
		]) {
			const result = await normalizeHeroImage(bytes);
			expect(result.ok && [result.width, result.height]).toEqual([
				12, 12,
			]);
		}
	});

	it("downscales to 2,400 px on the longest edge and never upscales", async () => {
		const large = await normalizeHeroImage(
			await solid(3000, 1500, "#0d9488", 3).jpeg().toBuffer(),
		);
		expect(large.ok && [large.width, large.height]).toEqual([
			HERO_MAX_OUTPUT_EDGE,
			1200,
		]);
		const small = await normalizeHeroImage(
			await solid(600, 300, "#0d9488", 3).jpeg().toBuffer(),
		);
		expect(small.ok && [small.width, small.height]).toEqual([600, 300]);
	});

	it("drops the source's metadata", async () => {
		const tagged = await solid(8, 8, "#1d4ed8", 3)
			.jpeg()
			.withExif({ IFD0: { Copyright: "Example Org" } })
			.toBuffer();
		expect((await sharp(tagged).metadata()).exif).toBeDefined();

		const result = await normalizeHeroImage(tagged);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
		expect(result.bytes.includes(Buffer.from("Example Org"))).toBe(false);
	});

	it("fails fast with too_large for a 9,000 x 9,000 PNG", async () => {
		const started = performance.now();
		expect(
			await normalizeHeroImage(await pngDeclaring(9000, 9000)),
		).toEqual({ ok: false, code: "too_large" });
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("refuses input over the 10 MiB cap before decoding", async () => {
		expect(BRAND_ASSET_MAX_BYTES.hero).toBe(10 * 1024 * 1024);
		const oversized = new Uint8Array(BRAND_ASSET_MAX_BYTES.hero + 1);
		oversized.set(await solid(2, 2, "#1d4ed8").png().toBuffer());
		expect(await normalizeHeroImage(oversized)).toEqual({
			ok: false,
			code: "too_large",
		});
	});

	it("takes a hero larger than a logo may be", async () => {
		const between = new Uint8Array(LOGO_MAX_INPUT_BYTES + 1);
		const jpeg = await solid(64, 64, "#1d4ed8", 3).jpeg().toBuffer();
		between.set(jpeg);
		// Trailing bytes after the JPEG's end marker are ignored by the
		// decoder and dropped by the re-encode.
		const result = await normalizeHeroImage(between);
		expect(result.ok && [result.width, result.height]).toEqual([64, 64]);
	});

	it("refuses a GIF, an SVG, HTML and a corrupt image as unsupported", async () => {
		const gif = await solid(8, 8, "#1d4ed8").gif().toBuffer();
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
		);
		const html = new TextEncoder().encode(
			"<!doctype html><html><body>not an image</body></html>",
		);
		const corrupt = Buffer.from(
			await solid(8, 8, "#1d4ed8").png().toBuffer(),
		);
		corrupt.fill(0x41, 16);

		for (const bytes of [gif, svg, html, corrupt]) {
			expect(await normalizeHeroImage(bytes)).toEqual({
				ok: false,
				code: "unsupported",
			});
		}
	});
});
