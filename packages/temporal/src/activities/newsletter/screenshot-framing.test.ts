/**
 * How a release-notes screenshot is framed and encoded: a small element is
 * widened so the email never stretches it, the crop stays inside the
 * viewport, and the encoded image keeps a 2x page at 1200 px without
 * enlarging a smaller one.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	CAPTURE_DEVICE_SCALE_FACTOR,
	CAPTURE_VIEWPORT,
	encodeNewsletterScreenshot,
	frameClip,
	MIN_CLIP_HEIGHT,
	MIN_CLIP_WIDTH,
	visiblePart,
} from "./screenshot-framing";

function png(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 159, g: 42, b: 58 },
		},
	})
		.png()
		.toBuffer();
}

describe("visiblePart", () => {
	it("cuts an element taller than the viewport to what is on screen", () => {
		const part = visiblePart({ x: 314, y: 56, width: 710, height: 3000 });
		expect(part).toEqual({
			x: 314,
			y: 56,
			width: 710,
			height: CAPTURE_VIEWPORT.height - 56,
		});
	});

	it("is null for a box scrolled out of view", () => {
		expect(
			visiblePart({ x: 0, y: -900, width: 400, height: 300 }),
		).toBeNull();
	});
});

describe("frameClip", () => {
	it("keeps an element that is already large enough", () => {
		const box = { x: 100, y: 50, width: 700, height: 400 };
		expect(frameClip(box)).toEqual(box);
	});

	it("widens a small element around its centre", () => {
		const clip = frameClip({ x: 400, y: 300, width: 100, height: 40 });
		expect(clip.width).toBe(MIN_CLIP_WIDTH);
		expect(clip.height).toBe(MIN_CLIP_HEIGHT);
		expect(clip.x + clip.width / 2).toBe(450);
		expect(clip.y + clip.height / 2).toBe(320);
	});

	it("keeps a widened crop inside the viewport at its edges", () => {
		const left = frameClip({ x: 0, y: 0, width: 80, height: 30 });
		expect(left).toEqual({
			x: 0,
			y: 0,
			width: MIN_CLIP_WIDTH,
			height: MIN_CLIP_HEIGHT,
		});
		const right = frameClip({
			x: CAPTURE_VIEWPORT.width - 80,
			y: CAPTURE_VIEWPORT.height - 30,
			width: 80,
			height: 30,
		});
		expect(right.x + right.width).toBe(CAPTURE_VIEWPORT.width);
		expect(right.y + right.height).toBe(CAPTURE_VIEWPORT.height);
	});

	it("cuts an element larger than the viewport to the viewport", () => {
		const clip = frameClip({ x: -20, y: -100, width: 1200, height: 2000 });
		expect(clip).toEqual({
			x: 0,
			y: 0,
			width: CAPTURE_VIEWPORT.width,
			height: CAPTURE_VIEWPORT.height,
		});
	});
});

describe("encodeNewsletterScreenshot", () => {
	it("encodes a whole 2x page as a 1200 px JPEG", async () => {
		const encoded = await encodeNewsletterScreenshot(
			await png(
				CAPTURE_VIEWPORT.width * CAPTURE_DEVICE_SCALE_FACTOR,
				CAPTURE_VIEWPORT.height * CAPTURE_DEVICE_SCALE_FACTOR,
			),
		);
		expect(encoded).not.toBeNull();
		expect(encoded?.width).toBe(1200);
		expect(encoded?.height).toBe(750);
		const meta = await sharp(encoded?.data).metadata();
		expect(meta.format).toBe("jpeg");
		expect(meta.chromaSubsampling).toBe("4:4:4");
	});

	it("never enlarges the smallest element crop", async () => {
		const encoded = await encodeNewsletterScreenshot(
			await png(
				MIN_CLIP_WIDTH * CAPTURE_DEVICE_SCALE_FACTOR,
				MIN_CLIP_HEIGHT * CAPTURE_DEVICE_SCALE_FACTOR,
			),
		);
		expect(encoded?.width).toBe(
			MIN_CLIP_WIDTH * CAPTURE_DEVICE_SCALE_FACTOR,
		);
	});
});
