import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { downscaleForVision, VISION_MAX_BYTES } from "../downscale-image";

async function makeJpeg(
	width: number,
	height: number,
	quality = 95,
): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 100, g: 150, b: 200 },
		},
	})
		.jpeg({ quality })
		.toBuffer();
}

async function makePng(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 4,
			background: { r: 30, g: 60, b: 90, alpha: 1 },
		},
	})
		.png()
		.toBuffer();
}

describe("downscaleForVision", () => {
	it("returns the buffer unchanged when under the limit", async () => {
		const small = await makeJpeg(400, 300);
		expect(small.length).toBeLessThan(VISION_MAX_BYTES);

		const result = await downscaleForVision(small, "image/jpeg");

		expect(result.downscaled).toBe(false);
		expect(result.buffer).toBe(small);
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.finalBytes).toBe(small.length);
	});

	it("downscales an oversized JPEG under the 5MB limit", async () => {
		// Create a large noisy image that exceeds 5MB as JPEG.
		const noise = Buffer.alloc(6000 * 6000 * 3);
		for (let i = 0; i < noise.length; i++) {
			noise[i] = Math.floor(Math.random() * 256);
		}
		const large = await sharp(noise, {
			raw: { width: 6000, height: 6000, channels: 3 },
		})
			.jpeg({ quality: 95 })
			.toBuffer();
		expect(large.length).toBeGreaterThan(VISION_MAX_BYTES);

		const result = await downscaleForVision(large, "image/jpeg");

		expect(result.downscaled).toBe(true);
		expect(result.finalBytes).toBeLessThanOrEqual(VISION_MAX_BYTES);
		expect(result.originalBytes).toBe(large.length);
		expect(result.mimeType).toBe("image/jpeg");

		const meta = await sharp(result.buffer).metadata();
		expect(meta.format).toBe("jpeg");
		expect(meta.width).toBeLessThanOrEqual(1568);
		expect(meta.height).toBeLessThanOrEqual(1568);
	});

	it("converts oversized PNGs to JPEG", async () => {
		// Large uncompressible PNG (noisy) that exceeds 5MB.
		const noise = Buffer.alloc(4000 * 4000 * 4);
		for (let i = 0; i < noise.length; i++) {
			noise[i] = Math.floor(Math.random() * 256);
		}
		const large = await sharp(noise, {
			raw: { width: 4000, height: 4000, channels: 4 },
		})
			.png()
			.toBuffer();
		expect(large.length).toBeGreaterThan(VISION_MAX_BYTES);

		const result = await downscaleForVision(large, "image/png");

		expect(result.downscaled).toBe(true);
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.finalBytes).toBeLessThanOrEqual(VISION_MAX_BYTES);
	});
});
