import { crc32 } from "node:zlib";
import sharp, { type Color, type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
	LOGO_MAX_INPUT_BYTES,
	normalizeLogo,
	sniffLogoFormat,
} from "../normalize-logo";

function solid(width: number, height: number, background: Color): Sharp {
	return sharp({ create: { width, height, channels: 4, background } });
}

/** A valid PNG whose header claims `width` x `height` (IHDR CRC fixed up). */
async function pngDeclaring(width: number, height: number): Promise<Buffer> {
	const png = Buffer.from(await solid(2, 2, "#1d4ed8").png().toBuffer());
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
	return png;
}

describe("sniffLogoFormat", () => {
	it("recognizes the four raster formats by their leading bytes", async () => {
		const base = solid(4, 4, "#1d4ed8");
		expect(sniffLogoFormat(await base.clone().png().toBuffer())).toBe(
			"png",
		);
		expect(sniffLogoFormat(await base.clone().jpeg().toBuffer())).toBe(
			"jpeg",
		);
		expect(sniffLogoFormat(await base.clone().gif().toBuffer())).toBe(
			"gif",
		);
		expect(sniffLogoFormat(await base.clone().webp().toBuffer())).toBe(
			"webp",
		);
	});

	it("rejects HTML, SVG and ICO bytes", () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		expect(
			sniffLogoFormat(encode("<!doctype html><html></html>")),
		).toBeNull();
		expect(
			sniffLogoFormat(
				encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
			),
		).toBeNull();
		expect(
			sniffLogoFormat(
				Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0]),
			),
		).toBeNull();
	});
});

describe("normalizeLogo", () => {
	it("re-encodes a logo as PNG and reports its dominant color", async () => {
		const result = await normalizeLogo(
			await solid(8, 8, "#1d4ed8").jpeg({ quality: 100 }).toBuffer(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(sniffLogoFormat(result.png)).toBe("png");
		expect([result.width, result.height]).toEqual([8, 8]);
		expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("downscales to 512px on the longest edge and never upscales", async () => {
		const large = await normalizeLogo(
			await solid(1024, 600, "#0d9488").png().toBuffer(),
		);
		const small = await normalizeLogo(
			await solid(40, 20, "#0d9488").png().toBuffer(),
		);
		expect(large.ok && [large.width, large.height]).toEqual([512, 300]);
		expect(small.ok && [small.width, small.height]).toEqual([40, 20]);
	});

	it("ignores a white background and transparency when picking the dominant color", async () => {
		const mark = await solid(16, 16, "#1d4ed8").png().toBuffer();
		const onWhite = await solid(64, 64, "#ffffff")
			.composite([{ input: mark, left: 24, top: 24 }])
			.png()
			.toBuffer();
		const onClear = await solid(64, 64, { r: 0, g: 0, b: 0, alpha: 0 })
			.composite([{ input: mark, left: 24, top: 24 }])
			.png()
			.toBuffer();
		const white = await solid(8, 8, "#ffffff").png().toBuffer();

		const [a, b, c] = await Promise.all(
			[onWhite, onClear, white].map((bytes) => normalizeLogo(bytes)),
		);
		expect(a.ok && a.dominantColor).toBe("#1d4ed8");
		expect(b.ok && b.dominantColor).toBe("#1d4ed8");
		expect(c.ok && c.dominantColor).toBeNull();
	});

	it("fails fast with too_large for a PNG declaring huge dimensions", async () => {
		const started = performance.now();
		const result = await normalizeLogo(await pngDeclaring(40_000, 40_000));
		expect(result).toEqual({ ok: false, code: "too_large" });
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("refuses input over the byte cap before decoding", async () => {
		const oversized = new Uint8Array(LOGO_MAX_INPUT_BYTES + 1);
		oversized.set(await solid(2, 2, "#1d4ed8").png().toBuffer());
		expect(await normalizeLogo(oversized)).toEqual({
			ok: false,
			code: "too_large",
		});
	});

	it("returns unsupported for HTML, SVG, and a corrupt image", async () => {
		const html = new TextEncoder().encode(
			"<!doctype html><html><body>not an image</body></html>",
		);
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
		);
		const corrupt = Buffer.from(
			await solid(8, 8, "#1d4ed8").png().toBuffer(),
		);
		corrupt.fill(0x41, 16);

		for (const bytes of [html, svg, corrupt]) {
			expect(await normalizeLogo(bytes)).toEqual({
				ok: false,
				code: "unsupported",
			});
		}
	});

	it("decodes only the first frame of an animated GIF", async () => {
		const frames = await Promise.all(
			["#1d4ed8", "#0d9488"].map((color) =>
				solid(10, 10, color).png().toBuffer(),
			),
		);
		const animated = await sharp(frames, { join: { animated: true } })
			.gif()
			.toBuffer();
		expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);

		const result = await normalizeLogo(animated);
		expect(result.ok && [result.width, result.height]).toEqual([10, 10]);
	});
});
