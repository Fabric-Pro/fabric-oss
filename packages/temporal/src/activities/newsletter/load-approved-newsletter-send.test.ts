/**
 * `loadApprovedNewsletterSendActivity` applies the reviewer's highlight order
 * and removals itself, through the shared `orderNewsletterHighlights` (real,
 * not mocked), and hands the workflow an empty removed list. The workflow's
 * own `applyRemovedHighlights` call is unchanged (replay safety), so these
 * tests also run the activity's result through it to prove nothing is
 * filtered twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRemovedHighlights } from "../../workflows/newsletter-highlight-filter";

const getNewsletterSendForSendPhase = vi.fn();

vi.mock("@repo/database", () => ({
	getNewsletterSendForSendPhase: (...a: unknown[]) =>
		getNewsletterSendForSendPhase(...a),
	// The activity parses the frozen content; the shape is covered by the
	// database package's own schema tests.
	newsletterContentSchema: { parse: (value: unknown) => value },
	coerceRemovedHighlightIndexes: (value: unknown) =>
		Array.isArray(value) ? value : [],
	coerceDeliveryDestination: (value: unknown) => value ?? "EMAIL",
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { loadApprovedNewsletterSendActivity } from "./load-approved-newsletter-send";

const image = { url: "https://example.com/image-proxy/b/k.png", alt: "Panel" };

function approvedRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "send-1",
		projectId: "p1",
		organizationId: "org-1",
		userId: null,
		status: "APPROVED",
		content: {
			schemaVersion: 1,
			headline: "h",
			intro: "i",
			hasMajorFeatures: true,
			highlights: [
				{ title: "a", description: "da" },
				{ title: "b", description: "db", images: [image] },
				{ title: "c", description: "dc" },
				{ title: "d", description: "dd" },
			],
		},
		deliveryDestination: "EMAIL",
		chatChannels: [],
		removedHighlightIndexes: [],
		highlightOrder: null,
		screenshotsEnabled: true,
		timeWindowEnd: new Date("2026-11-01T00:00:00.000Z"),
		...overrides,
	};
}

async function load() {
	return loadApprovedNewsletterSendActivity({
		sendId: "send-1",
		projectName: "Example",
	});
}

const titles = (highlights: Array<{ title: string }>) =>
	highlights.map((h) => h.title);

describe("loadApprovedNewsletterSendActivity", () => {
	beforeEach(() => {
		getNewsletterSendForSendPhase.mockReset();
	});

	it("applies the reviewer's order, then drops removed highlights", async () => {
		getNewsletterSendForSendPhase.mockResolvedValue(
			approvedRow({
				highlightOrder: [3, 1, 0, 2],
				removedHighlightIndexes: [0],
			}),
		);

		const data = await load();

		expect(titles(data.content.highlights)).toEqual(["d", "b", "c"]);
		expect(data.removedHighlightIndexes).toEqual([]);
		expect(data.content.hasMajorFeatures).toBe(true);
	});

	it("keeps each highlight's images with it when reordered", async () => {
		getNewsletterSendForSendPhase.mockResolvedValue(
			approvedRow({ highlightOrder: [1, 0, 2, 3] }),
		);

		const data = await load();

		expect(data.content.highlights[0]).toMatchObject({
			title: "b",
			images: [image],
		});
	});

	it("is not filtered a second time by the workflow's applyRemovedHighlights", async () => {
		getNewsletterSendForSendPhase.mockResolvedValue(
			approvedRow({
				highlightOrder: [2, 3],
				removedHighlightIndexes: [1],
			}),
		);

		const data = await load();
		const sent = applyRemovedHighlights(
			data.content,
			data.removedHighlightIndexes,
		);

		expect(titles(sent.highlights)).toEqual(["c", "d", "a"]);
	});

	it("uses the natural order when no order was stored", async () => {
		getNewsletterSendForSendPhase.mockResolvedValue(
			approvedRow({ removedHighlightIndexes: [2] }),
		);

		const data = await load();

		expect(titles(data.content.highlights)).toEqual(["a", "b", "d"]);
	});

	it("reports no major features when the reviewer removed every highlight", async () => {
		getNewsletterSendForSendPhase.mockResolvedValue(
			approvedRow({
				highlightOrder: [3, 2, 1, 0],
				removedHighlightIndexes: [0, 1, 2, 3],
			}),
		);

		const data = await load();

		expect(data.content.highlights).toEqual([]);
		expect(data.content.hasMajorFeatures).toBe(false);
	});

	it("refuses a row that is not APPROVED", async () => {
		getNewsletterSendForSendPhase.mockResolvedValue(
			approvedRow({ status: "PENDING_APPROVAL" }),
		);

		await expect(load()).rejects.toThrow("not in a sendable state");
	});
});
