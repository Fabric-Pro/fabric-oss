/**
 * Which highlights get an automatic screenshot, and the review-off publish:
 * published copies are embedded, and a copy the embed did not use is deleted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createNewsletterCaptureRows: vi.fn(),
	embedCapturedNewsletterImages: vi.fn(),
	listNewsletterSendImages: vi.fn(),
	publishNewsletterImages: vi.fn(),
	deleteNewsletterImageObjects: vi.fn(),
	heartbeat: vi.fn(),
	logWarn: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mocks.heartbeat }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.logWarn, error: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	NEWSLETTER_AUTO_CAPTURES_MAX: 8,
	NEWSLETTER_CAPTURE_BRIEF_MAX: 500,
	createNewsletterCaptureRows: mocks.createNewsletterCaptureRows,
	embedCapturedNewsletterImages: mocks.embedCapturedNewsletterImages,
	failNewsletterImageCapture: vi.fn(),
	listNewsletterSendImages: mocks.listNewsletterSendImages,
}));
vi.mock(
	"@repo/database/prisma/queries/projects/newsletter-image-publish",
	() => ({
		publishNewsletterImages: mocks.publishNewsletterImages,
		deleteNewsletterImageObjects: mocks.deleteNewsletterImageObjects,
	}),
);

import {
	createNewsletterCaptureRowsActivity,
	publishNewsletterScreenshotsActivity,
	screenshotCaptures,
} from "./screenshot-capture-rows";

function content(
	highlights: Array<{ visualChange?: boolean; captureBrief?: string }>,
) {
	return {
		schemaVersion: 1 as const,
		headline: "November update",
		intro: "",
		hasMajorFeatures: true,
		highlights: highlights.map((h, i) => ({
			title: `Highlight ${i}`,
			description: "Details.",
			...h,
		})),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteNewsletterImageObjects.mockResolvedValue(undefined);
});

describe("screenshotCaptures", () => {
	it("takes visible changes that have a brief, in order", () => {
		expect(
			screenshotCaptures(
				content([
					{
						visualChange: true,
						captureBrief: " The filters panel. ",
					},
					{ visualChange: false, captureBrief: "Ignored." },
					{ visualChange: true },
					{},
					{ visualChange: true, captureBrief: "The export dialog." },
				]),
			),
		).toEqual({
			captures: [
				{ highlightIndex: 0, prompt: "The filters panel." },
				{ highlightIndex: 4, prompt: "The export dialog." },
			],
			skipped: 0,
		});
	});

	it("caps the captures of one send and counts the rest", () => {
		const many = content(
			Array.from({ length: 12 }, () => ({
				visualChange: true,
				captureBrief: "A screen.",
			})),
		);

		const { captures, skipped } = screenshotCaptures(many);

		expect(captures).toHaveLength(8);
		expect(skipped).toBe(4);
	});
});

describe("createNewsletterCaptureRowsActivity", () => {
	it("creates no rows when nothing is a visible change", async () => {
		const rows = await createNewsletterCaptureRowsActivity({
			sendId: "send-1",
			projectId: "p1",
			content: content([{ visualChange: false }]),
			included: false,
			createdByUserId: "user-1",
		});

		expect(rows).toEqual([]);
		expect(mocks.createNewsletterCaptureRows).not.toHaveBeenCalled();
	});

	it("creates a row per capture with the brief as its prompt", async () => {
		mocks.createNewsletterCaptureRows.mockResolvedValue([
			{ id: "img-1", highlightIndex: 0 },
		]);

		await createNewsletterCaptureRowsActivity({
			sendId: "send-1",
			projectId: "p1",
			content: content([
				{ visualChange: true, captureBrief: "A screen." },
			]),
			included: true,
			createdByUserId: "user-1",
		});

		expect(mocks.createNewsletterCaptureRows).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
			captures: [{ highlightIndex: 0, prompt: "A screen." }],
			included: true,
			createdByUserId: "user-1",
		});
		expect(mocks.logWarn).not.toHaveBeenCalled();
	});

	it("logs how many visible changes the cap left without a screenshot", async () => {
		mocks.createNewsletterCaptureRows.mockResolvedValue([]);

		await createNewsletterCaptureRowsActivity({
			sendId: "send-1",
			projectId: "p1",
			content: content(
				Array.from({ length: 10 }, () => ({
					visualChange: true,
					captureBrief: "A screen.",
				})),
			),
			included: false,
			createdByUserId: "user-1",
		});

		expect(mocks.logWarn).toHaveBeenCalledWith(
			"[Newsletter] visible changes left without a screenshot",
			{ sendId: "send-1", skipped: 2, cap: 8 },
		);
		expect(
			mocks.createNewsletterCaptureRows.mock.calls[0][0].captures,
		).toHaveLength(8);
	});
});

describe("publishNewsletterScreenshotsActivity", () => {
	const input = {
		sendId: "send-1",
		projectId: "p1",
		content: content([{ visualChange: true, captureBrief: "A screen." }]),
	};

	it("returns the content unchanged when nothing was published", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([]);
		mocks.publishNewsletterImages.mockResolvedValue([]);

		await expect(publishNewsletterScreenshotsActivity(input)).resolves.toBe(
			input.content,
		);
		expect(mocks.embedCapturedNewsletterImages).not.toHaveBeenCalled();
	});

	it("embeds the published copies and deletes the ones not embedded", async () => {
		const images = [{ id: "img-1" }, { id: "img-2" }];
		mocks.listNewsletterSendImages.mockResolvedValue(images);
		mocks.publishNewsletterImages.mockResolvedValue([
			{ imageId: "img-1", publicKey: "newsletter-public/a.jpg" },
			{ imageId: "img-2", publicKey: "newsletter-public/b.jpg" },
		]);
		const embedded = { ...input.content, headline: "with images" };
		mocks.embedCapturedNewsletterImages.mockResolvedValue({
			content: embedded,
			embedded: ["img-1"],
		});

		const result = await publishNewsletterScreenshotsActivity(input);

		expect(mocks.publishNewsletterImages).toHaveBeenCalledWith({
			sendId: "send-1",
			images,
			removedHighlightIndexes: [],
			highlightCount: 1,
			afterEachCopy: expect.any(Function),
		});
		expect(result).toBe(embedded);
		expect(mocks.deleteNewsletterImageObjects).toHaveBeenCalledWith([
			"newsletter-public/b.jpg",
		]);
	});

	it("heartbeats after each copy, so a long publish is not timed out", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([{ id: "img-1" }]);
		mocks.publishNewsletterImages.mockImplementation(
			async (args: { afterEachCopy: () => void }) => {
				args.afterEachCopy();
				args.afterEachCopy();
				return [];
			},
		);

		await publishNewsletterScreenshotsActivity(input);

		// Once on entry, then once per copy.
		expect(mocks.heartbeat).toHaveBeenCalledTimes(3);
	});
});
