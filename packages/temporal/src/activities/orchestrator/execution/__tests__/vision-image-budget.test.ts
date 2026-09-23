/**
 * Pasted images skipped the browser-side shaping, and nothing on the server
 * bounded image size or count — one oversize screenshot failed the whole
 * turn at the provider (review F37). Over-budget images are now left out
 * and the model is told which.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));

const {
	budgetImageAttachments,
	MAX_ENCODED_BYTES_PER_IMAGE,
	MAX_IMAGES_PER_REQUEST,
	omittedImagesNote,
	spliceImagePartsIntoLastUserMessage,
} = await import("../vision-image-attachments");

const image = (filename: string, rawBytes: number) => ({
	filename,
	mediaType: "image/png",
	bytes: new Uint8Array(rawBytes),
});

// Largest raw image that still fits the encoded per-image cap.
const MAX_RAW = Math.floor((MAX_ENCODED_BYTES_PER_IMAGE / 4) * 3);

describe("budgetImageAttachments", () => {
	it("keeps images within budget", () => {
		const images = [image("a.png", 1_000), image("b.png", 2_000)];
		expect(budgetImageAttachments(images)).toEqual({
			kept: images,
			omitted: [],
		});
	});

	it("leaves out an image over the per-image cap once encoded", () => {
		// Under 5 MiB on disk, over it as base64.
		const big = image("screenshot.png", MAX_RAW + 3_000);
		const { kept, omitted } = budgetImageAttachments([
			image("small.png", 10),
			big,
		]);
		expect(kept.map((i) => i.filename)).toEqual(["small.png"]);
		expect(omitted).toEqual([
			{ filename: "screenshot.png", reason: "too_large" },
		]);
	});

	it("caps the number of images per request", () => {
		const images = Array.from(
			{ length: MAX_IMAGES_PER_REQUEST + 2 },
			(_, i) => image(`${i}.png`, 10),
		);
		const { kept, omitted } = budgetImageAttachments(images);
		expect(kept).toHaveLength(MAX_IMAGES_PER_REQUEST);
		expect(omitted.every((o) => o.reason === "too_many")).toBe(true);
	});

	it("caps the total image bytes per request", () => {
		const images = Array.from({ length: 5 }, (_, i) =>
			image(`${i}.png`, MAX_RAW - 10),
		);
		const { kept, omitted } = budgetImageAttachments(images);
		expect(kept).toHaveLength(4);
		expect(omitted).toEqual([
			{ filename: "4.png", reason: "request_budget" },
		]);
	});
});

describe("omitted image note", () => {
	it("is spliced into the user message alongside the kept images", () => {
		const messages: Array<{ role?: string; content?: unknown }> = [
			{ role: "user", content: "What is in these?" },
		];
		const note = omittedImagesNote([
			{ filename: "screenshot.png", reason: "too_large" },
		]);
		const attached = spliceImagePartsIntoLastUserMessage(
			messages,
			[image("small.png", 10)],
			note,
		);
		expect(attached).toBe(1);
		const content = messages[0].content as Array<{
			type: string;
			text?: string;
		}>;
		expect(content.map((part) => part.type)).toEqual([
			"text",
			"text",
			"file",
		]);
		expect(content[1].text).toMatch(/screenshot\.png/);
	});

	it("is added even when every image was left out", () => {
		const messages: Array<{ role?: string; content?: unknown }> = [
			{ role: "user", content: "Look" },
		];
		spliceImagePartsIntoLastUserMessage(
			messages,
			[],
			omittedImagesNote([{ filename: "x.png", reason: "too_large" }]),
		);
		expect(Array.isArray(messages[0].content)).toBe(true);
	});
});
