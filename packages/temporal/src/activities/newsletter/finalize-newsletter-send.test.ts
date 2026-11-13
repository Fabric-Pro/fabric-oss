/**
 * `finalizeNewsletterSendActivity` removes the screenshots of a send that
 * will never go out: one that failed or was skipped. A sent send keeps its
 * published images and frees its review folder. A guarded finalize that
 * matched nothing touches neither.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	finalizeNewsletterSend: vi.fn(),
	advanceNewsletterLastSentAt: vi.fn(),
	discardExpiredReviewImages: vi.fn(),
	clearNewsletterSendFolder: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/database", () => ({
	finalizeNewsletterSend: mocks.finalizeNewsletterSend,
	advanceNewsletterLastSentAt: mocks.advanceNewsletterLastSentAt,
	withoutCaptureHints: (content: unknown) => content,
}));
vi.mock("./discard-expired-review-images", () => ({
	discardExpiredReviewImages: mocks.discardExpiredReviewImages,
	clearNewsletterSendFolder: mocks.clearNewsletterSendFolder,
}));

import { finalizeNewsletterSendActivity } from "./finalize-newsletter-send";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.finalizeNewsletterSend.mockResolvedValue({ finalized: true });
	mocks.discardExpiredReviewImages.mockResolvedValue(undefined);
});

describe("finalizeNewsletterSendActivity — screenshots of a send that never goes out", () => {
	it.each(["FAILED", "SKIPPED_EMPTY"] as const)(
		"removes the images of a %s send",
		async (status) => {
			await finalizeNewsletterSendActivity({
				sendId: "send-1",
				projectId: "p1",
				status,
			});

			expect(mocks.discardExpiredReviewImages).toHaveBeenCalledWith(
				"p1",
				"send-1",
			);
		},
	);

	it.each(["SENT", "PARTIAL"] as const)(
		"keeps the published images of a %s send and frees its review folder",
		async (status) => {
			await finalizeNewsletterSendActivity({
				sendId: "send-1",
				projectId: "p1",
				status,
			});

			expect(mocks.discardExpiredReviewImages).not.toHaveBeenCalled();
			expect(mocks.clearNewsletterSendFolder).toHaveBeenCalledWith(
				"p1",
				"send-1",
			);
		},
	);

	it("keeps them when a guarded finalize changed nothing", async () => {
		mocks.finalizeNewsletterSend.mockResolvedValue({ finalized: false });

		await finalizeNewsletterSendActivity({
			sendId: "send-1",
			projectId: "p1",
			status: "FAILED",
			expectStatus: "APPROVED",
		});

		expect(mocks.discardExpiredReviewImages).not.toHaveBeenCalled();
		expect(mocks.clearNewsletterSendFolder).not.toHaveBeenCalled();
	});
});
