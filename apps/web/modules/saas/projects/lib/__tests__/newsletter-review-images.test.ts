import { describe, expect, it } from "vitest";
import {
	approveButtonLabel,
	imagesByHighlight,
	includedImagesLine,
	reviewSummaryLine,
	summarizeReviewImages,
} from "../newsletter-review-images";

function image(
	over: Partial<{
		highlightIndex: number;
		captureState: string;
		included: boolean;
		url: string | null;
	}> = {},
) {
	return {
		highlightIndex: 0,
		captureState: "READY",
		included: true,
		url: "https://example.com/signed.png",
		...over,
	};
}

describe("summarizeReviewImages", () => {
	it.each([
		{
			name: "no images",
			images: [],
			removed: [],
			expected: { available: 0, included: 0 },
		},
		{
			name: "one included image",
			images: [image()],
			removed: [],
			expected: { available: 1, included: 1 },
		},
		{
			name: "an unticked image is available but not included",
			images: [image(), image({ included: false })],
			removed: [],
			expected: { available: 2, included: 1 },
		},
		{
			name: "an image under a removed highlight does not count",
			images: [
				image({ highlightIndex: 0 }),
				image({ highlightIndex: 1 }),
			],
			removed: [1],
			expected: { available: 1, included: 1 },
		},
		{
			name: "an image without a url does not count",
			images: [image({ url: null })],
			removed: [],
			expected: { available: 0, included: 0 },
		},
		{
			name: "an image that is still capturing does not count",
			images: [image({ captureState: "CAPTURING" })],
			removed: [],
			expected: { available: 0, included: 0 },
		},
		{
			name: "a failed image does not count",
			images: [image({ captureState: "FAILED", url: null })],
			removed: [],
			expected: { available: 0, included: 0 },
		},
	])("$name", ({ images, removed, expected }) => {
		expect(summarizeReviewImages(images, new Set(removed))).toEqual(
			expected,
		);
	});
});

describe("approveButtonLabel", () => {
	it.each([
		{ included: 0, label: "Approve & send as text" },
		{ included: 1, label: "Approve & send with 1 image" },
		{ included: 2, label: "Approve & send with 2 images" },
	])("$included included → $label", ({ included, label }) => {
		expect(approveButtonLabel(included)).toBe(label);
	});
});

describe("reviewSummaryLine", () => {
	it.each([
		{ highlights: 4, images: 2, line: "4 highlights · 2 images" },
		{ highlights: 1, images: 1, line: "1 highlight · 1 image" },
		{ highlights: 3, images: 0, line: "3 highlights · 0 images" },
	])("$line", ({ highlights, images, line }) => {
		expect(reviewSummaryLine(highlights, images)).toBe(line);
	});
});

describe("includedImagesLine", () => {
	it("is omitted when there is no image to include", () => {
		expect(includedImagesLine({ available: 0, included: 0 })).toBeNull();
	});

	it.each([
		{ available: 1, included: 1, line: "1 of 1 image included" },
		{ available: 4, included: 3, line: "3 of 4 images included" },
	])("$line", ({ available, included, line }) => {
		expect(includedImagesLine({ available, included })).toBe(line);
	});
});

describe("imagesByHighlight", () => {
	it("groups images by highlight index, keeping their order", () => {
		const a = { id: "a", highlightIndex: 2 };
		const b = { id: "b", highlightIndex: 0 };
		const c = { id: "c", highlightIndex: 2 };
		const grouped = imagesByHighlight([a, b, c]);
		expect(grouped.get(2)).toEqual([a, c]);
		expect(grouped.get(0)).toEqual([b]);
		expect(grouped.get(1)).toBeUndefined();
	});
});
