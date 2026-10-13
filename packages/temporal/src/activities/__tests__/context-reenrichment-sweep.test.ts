import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listContextsDueForReenrichment: vi.fn(),
	setContextEnrichmentRetryAt: vi.fn(),
	findUnique: vi.fn(),
	embedSingleContextActivity: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { projectContext: { findUnique: mocks.findUnique } },
	listContextsDueForReenrichment: mocks.listContextsDueForReenrichment,
	setContextEnrichmentRetryAt: mocks.setContextEnrichmentRetryAt,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../context-embedding", () => ({
	embedSingleContextActivity: mocks.embedSingleContextActivity,
}));

import { reenrichDeferredContextsActivity } from "../context-reenrichment-sweep";

const PAST = new Date("2026-10-13T08:00:00.000Z");

function row(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		type: "FILE",
		originalFilename: "spec.yaml",
		mimeType: "application/yaml",
		sourceUrl: null,
		sourceTitle: null,
		sourcePath: null,
		contextEnrichmentRetryAt: PAST,
		...overrides,
	};
}

/** The marker as the embed left it, per context id. */
function markerAfterEmbed(markers: Record<string, Date | null>) {
	mocks.findUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) => ({
			contextEnrichmentRetryAt: markers[where.id] ?? null,
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.embedSingleContextActivity.mockResolvedValue({ success: true });
});

describe("reenrichDeferredContextsActivity", () => {
	it("re-embeds each due context through the guarded re-embed, as its owner", async () => {
		mocks.listContextsDueForReenrichment.mockResolvedValue([row("ctx-1")]);
		markerAfterEmbed({ "ctx-1": null });

		const result = await reenrichDeferredContextsActivity();

		expect(mocks.listContextsDueForReenrichment).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 5 }),
		);
		expect(mocks.embedSingleContextActivity).toHaveBeenCalledWith({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			type: "FILE",
			metadata: {
				filename: "spec.yaml",
				mimeType: "application/yaml",
				sourceUrl: undefined,
				sourceTitle: undefined,
				sourcePath: undefined,
			},
			reembed: true,
		});
		expect(result).toMatchObject({ candidates: 1, reenriched: 1 });
	});

	it("stops at the first context the still-spent plan defers again", async () => {
		mocks.listContextsDueForReenrichment.mockResolvedValue([
			row("ctx-1"),
			row("ctx-2"),
		]);
		markerAfterEmbed({ "ctx-1": new Date(Date.now() + 60 * 60 * 1000) });

		const result = await reenrichDeferredContextsActivity();

		expect(mocks.embedSingleContextActivity).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ deferredAgain: 1, reenriched: 0 });
		expect(mocks.setContextEnrichmentRetryAt).not.toHaveBeenCalled();
	});

	it("pushes a context whose re-embed throws back by the backoff and moves on", async () => {
		mocks.listContextsDueForReenrichment.mockResolvedValue([
			row("ctx-1"),
			row("ctx-2"),
		]);
		mocks.embedSingleContextActivity
			.mockRejectedValueOnce(new Error("provider outage"))
			.mockResolvedValueOnce({ success: true });
		markerAfterEmbed({});
		const before = Date.now();

		const result = await reenrichDeferredContextsActivity();

		const [id, retryAt] = mocks.setContextEnrichmentRetryAt.mock.calls[0];
		expect(id).toBe("ctx-1");
		expect((retryAt as Date).getTime()).toBeGreaterThan(before);
		expect(result).toMatchObject({ failed: 1, reenriched: 1 });
	});

	it("clears a context the embed left untouched (emptied or deleted), so it cannot hold the queue", async () => {
		mocks.listContextsDueForReenrichment.mockResolvedValue([row("ctx-1")]);
		markerAfterEmbed({ "ctx-1": PAST });

		const result = await reenrichDeferredContextsActivity();

		expect(mocks.setContextEnrichmentRetryAt).toHaveBeenCalledWith(
			"ctx-1",
			null,
		);
		expect(result).toMatchObject({ cleared: 1 });
	});

	it("clears a context with no owner to run as instead of re-embedding it", async () => {
		mocks.listContextsDueForReenrichment.mockResolvedValue([
			row("ctx-1", { userId: null }),
		]);

		const result = await reenrichDeferredContextsActivity();

		expect(mocks.embedSingleContextActivity).not.toHaveBeenCalled();
		expect(mocks.setContextEnrichmentRetryAt).toHaveBeenCalledWith(
			"ctx-1",
			null,
		);
		expect(result).toMatchObject({ cleared: 1 });
	});

	it("starts no new context once the run's time budget is spent", async () => {
		mocks.listContextsDueForReenrichment.mockResolvedValue([
			row("ctx-1"),
			row("ctx-2"),
			row("ctx-3"),
		]);
		markerAfterEmbed({});
		const start = Date.now();
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValueOnce(start)
			.mockReturnValue(start + 4 * 60 * 1000);

		try {
			const result = await reenrichDeferredContextsActivity();

			expect(mocks.embedSingleContextActivity).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ reenriched: 1, notReached: 2 });
		} finally {
			clock.mockRestore();
		}
	});
});
