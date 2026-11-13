/**
 * Reviewers sign off on a recipient list, so the organization has to be synced
 * before the send is parked rather than only at delivery (Fizzy #1986, FR16).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	holdNewsletterForApproval: vi.fn(),
	emitNewsletterApprovalPendingNotification: vi.fn(),
	getNewsletterSendProjectId: vi.fn(),
	syncOrganizationSubscribers: vi.fn(),
	recordOrganizationSyncFailure: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const schema = await vi.importActual<
		typeof import("@repo/database/src/newsletter-schema")
	>("@repo/database/src/newsletter-schema");
	return { ...db, withoutCaptureHints: schema.withoutCaptureHints };
});
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { holdNewsletterForApprovalActivity } from "./hold-newsletter-for-approval";

const INPUT = {
	sendId: "send_1",
	content: {
		schemaVersion: 1 as const,
		headline: "Release notes",
		intro: "",
		hasMajorFeatures: true,
		highlights: [
			{
				title: "Saved filters",
				description: "Filters can be saved.",
				visualChange: true,
				captureBrief: "The filters panel with one saved filter.",
			},
		],
	},
	aiUsageTokens: null,
};

beforeEach(() => {
	for (const mock of Object.values(db)) {
		mock.mockReset();
	}
	db.getNewsletterSendProjectId.mockResolvedValue("proj_1");
	db.syncOrganizationSubscribers.mockResolvedValue({ added: 0, removed: 0 });
	db.recordOrganizationSyncFailure.mockResolvedValue({});
});

describe("holdNewsletterForApprovalActivity", () => {
	it("syncs the organization before parking the send", async () => {
		await holdNewsletterForApprovalActivity(INPUT);

		expect(db.syncOrganizationSubscribers).toHaveBeenCalledWith("proj_1");
		expect(
			db.syncOrganizationSubscribers.mock.invocationCallOrder[0],
		).toBeLessThan(
			db.holdNewsletterForApproval.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("still parks the send when the sync fails", async () => {
		db.syncOrganizationSubscribers.mockRejectedValue(new Error("db down"));

		await holdNewsletterForApprovalActivity(INPUT);

		expect(db.holdNewsletterForApproval).toHaveBeenCalledTimes(1);
		expect(db.recordOrganizationSyncFailure).toHaveBeenCalledWith(
			"proj_1",
			"db down",
		);
	});

	it("parks the content without the screenshot capture hints", async () => {
		await holdNewsletterForApprovalActivity(INPUT);

		const held = db.holdNewsletterForApproval.mock.calls[0]?.[0];
		expect(held.content.highlights).toEqual([
			{ title: "Saved filters", description: "Filters can be saved." },
		]);
	});

	it("skips the sync when the send has no project", async () => {
		db.getNewsletterSendProjectId.mockResolvedValue(null);

		await holdNewsletterForApprovalActivity(INPUT);

		expect(db.syncOrganizationSubscribers).not.toHaveBeenCalled();
		expect(db.holdNewsletterForApproval).toHaveBeenCalledTimes(1);
	});
});
