import { crc32 } from "node:zlib";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
	normalizeExportImage,
	sniffExportImageFormat,
} from "../normalize-image";
import { PROPOSAL_EXPORT_LIMITS } from "../types";

const OPAQUE = { r: 40, g: 90, b: 160 };
const TRANSLUCENT = { r: 40, g: 90, b: 160, alpha: 0.5 };

function canvas(width: number, height: number, alpha = false): Sharp {
	return sharp({
		create: {
			width,
			height,
			channels: alpha ? 4 : 3,
			background: alpha ? TRANSLUCENT : OPAQUE,
		},
	});
}

/** A PNG whose header declares `width` x `height`, with a valid CRC. */
async function pngDeclaring(width: number, height: number): Promise<Buffer> {
	const png = Buffer.from(await canvas(4, 4).png().toBuffer());
	// Signature (8) + IHDR length (4) + "IHDR" (4), then width and height.
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
	return png;
}

describe("normalizeExportImage", () => {
	it("keeps a PNG with an alpha channel as PNG", async () => {
		const result = await normalizeExportImage(
			await canvas(120, 80, true).png().toBuffer(),
		);

		expect(result).toMatchObject({
			ok: true,
			image: { mimeType: "image/png", width: 120, height: 80 },
		});
		if (result.ok) {
			expect(sniffExportImageFormat(result.image.bytes)).toBe("png");
		}
	});

	it("re-encodes an opaque image as JPEG", async () => {
		const result = await normalizeExportImage(
			await canvas(120, 80).png().toBuffer(),
		);

		expect(result).toMatchObject({
			ok: true,
			image: { mimeType: "image/jpeg", width: 120, height: 80 },
		});
		if (result.ok) {
			expect(sniffExportImageFormat(result.image.bytes)).toBe("jpeg");
		}
	});

	it.each([
		["GIF", () => canvas(64, 48, true).gif().toBuffer()],
		["WebP", () => canvas(64, 48).webp().toBuffer()],
		["transparent WebP", () => canvas(64, 48, true).webp().toBuffer()],
	])("turns a %s into PNG or JPEG", async (_name, build) => {
		const result = await normalizeExportImage(await build());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(["image/png", "image/jpeg"]).toContain(
				result.image.mimeType,
			);
			const sniffed = sniffExportImageFormat(result.image.bytes);
			expect(sniffed).toBe(
				result.image.mimeType === "image/png" ? "png" : "jpeg",
			);
			expect(result.image).toMatchObject({ width: 64, height: 48 });
		}
	});

	it("drops EXIF metadata and anything appended to the image data", async () => {
		const jpeg = await canvas(32, 32)
			.jpeg()
			.withExif({ IFD0: { Copyright: "Example Org secret note" } })
			.toBuffer();
		expect((await sharp(jpeg).metadata()).exif).toBeDefined();
		const input = Buffer.concat([
			jpeg,
			Buffer.from("<script>trailing payload</script>"),
		]);

		const result = await normalizeExportImage(input);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const output = result.image.bytes;
			expect((await sharp(output).metadata()).exif).toBeUndefined();
			expect(output.includes("Example Org secret note")).toBe(false);
			expect(output.includes("trailing payload")).toBe(false);
		}
	});

	it("shrinks the longest edge to the export's limit, never enlarging", async () => {
		const wide = await normalizeExportImage(
			await canvas(3000, 1000).jpeg().toBuffer(),
		);
		expect(wide).toMatchObject({
			ok: true,
			image: { width: PROPOSAL_EXPORT_LIMITS.maxImageEdge, height: 800 },
		});

		const logo = await normalizeExportImage(
			await canvas(800, 200, true).png().toBuffer(),
			{ maxEdge: 400 },
		);
		expect(logo).toMatchObject({
			ok: true,
			image: { width: 400, height: 100 },
		});

		const small = await normalizeExportImage(
			await canvas(20, 10).png().toBuffer(),
		);
		expect(small).toMatchObject({
			ok: true,
			image: { width: 20, height: 10 },
		});
	});

	it("refuses SVG, ICO and text, whatever they claim to be", async () => {
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
		);
		const ico = Buffer.from([
			0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01,
			0x00, 0x20, 0x00,
		]);

		for (const bytes of [svg, ico, Buffer.from("not an image at all")]) {
			expect(await normalizeExportImage(bytes)).toEqual({
				ok: false,
				code: "unsupported",
			});
		}
	});

	it("refuses bytes whose header does not decode as the sniffed format", async () => {
		const png = await canvas(16, 16).png().toBuffer();
		const corrupt = Buffer.concat([
			png.subarray(0, 8),
			Buffer.alloc(64, 0x41),
		]);

		expect(await normalizeExportImage(corrupt)).toEqual({
			ok: false,
			code: "unsupported",
		});
	});

	it("refuses an image over the byte cap before reading it", async () => {
		const png = await canvas(64, 64).png().toBuffer();

		expect(
			await normalizeExportImage(png, { maxBytes: png.byteLength - 1 }),
		).toEqual({ ok: false, code: "too_large" });
	});

	it("refuses an image declaring more pixels than allowed before decoding it", async () => {
		// Inside sharp's own default limit, outside the export's.
		const bomb = await pngDeclaring(7000, 7000);
		expect((await sharp(bomb).metadata()).width).toBe(7000);
		expect(7000 * 7000).toBeGreaterThan(
			PROPOSAL_EXPORT_LIMITS.maxImagePixels,
		);

		expect(await normalizeExportImage(bomb)).toEqual({
			ok: false,
			code: "too_large",
		});
	});
});
