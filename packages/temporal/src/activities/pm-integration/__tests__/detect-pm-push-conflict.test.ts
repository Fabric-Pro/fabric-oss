import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	previewPmSyncConflict,
	stampPmSyncConflict,
	getPmSyncBaseline,
	fetchPmTicket,
	computePmHash,
} = vi.hoisted(() => ({
	previewPmSyncConflict: vi.fn(),
	stampPmSyncConflict: vi.fn(),
	getPmSyncBaseline: vi.fn(),
	fetchPmTicket: vi.fn(),
	computePmHash: vi.fn(),
}));

vi.mock("../preview-pm-sync-conflict", () => ({ previewPmSyncConflict }));
vi.mock("../hierarchy-sync", () => ({
	stampPmSyncConflict,
	getPmSyncBaseline,
}));
vi.mock("../fetch-pm-ticket", () => ({ fetchPmTicket }));
vi.mock("../pm-sync-hash", () => ({ computePmHash }));

import { detectAndStampPmPushConflict } from "../detect-pm-push-conflict";

// biome-ignore lint/suspicious/noExplicitAny: minimal capabilities fixture for the test
const CAPS = { taskGet: { toolName: "get" } } as any;
const FALLBACK_INPUT = {
	itemId: "s1",
	itemType: "story" as const,
	projectId: "p1",
	mcpConfigId: "cfg",
	containerId: "c1",
	userId: "u1",
	organizationId: "org1",
};
const FAST_INPUT = {
	...FALLBACK_INPUT,
	externalId: "ext-1",
	capabilities: CAPS,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("detectAndStampPmPushConflict — fast path (reuses caller capabilities)", () => {
	it("stamps CONFLICT on drift WITHOUT re-discovering capabilities", async () => {
		getPmSyncBaseline.mockResolvedValue("baseline-hash");
		fetchPmTicket.mockResolvedValue({ title: "T", description: "D" });
		computePmHash.mockReturnValue("drifted-hash");
		const r = await detectAndStampPmPushConflict(FAST_INPUT);
		expect(r.hasConflict).toBe(true);
		expect(fetchPmTicket).toHaveBeenCalledTimes(1);
		expect(stampPmSyncConflict).toHaveBeenCalledWith("story", "s1");
		// The whole point: the slow standalone detector is NOT used.
		expect(previewPmSyncConflict).not.toHaveBeenCalled();
	});

	it("no conflict when the fetched hash matches the baseline", async () => {
		getPmSyncBaseline.mockResolvedValue("same-hash");
		fetchPmTicket.mockResolvedValue({ title: "T", description: "D" });
		computePmHash.mockReturnValue("same-hash");
		const r = await detectAndStampPmPushConflict(FAST_INPUT);
		expect(r.hasConflict).toBe(false);
		expect(stampPmSyncConflict).not.toHaveBeenCalled();
		expect(previewPmSyncConflict).not.toHaveBeenCalled();
	});

	it("no conflict (no fetch) when there is no baseline yet", async () => {
		getPmSyncBaseline.mockResolvedValue(null);
		const r = await detectAndStampPmPushConflict(FAST_INPUT);
		expect(r.hasConflict).toBe(false);
		expect(fetchPmTicket).not.toHaveBeenCalled();
	});

	it("no conflict when the PM read throws (lets the push proceed)", async () => {
		getPmSyncBaseline.mockResolvedValue("baseline-hash");
		fetchPmTicket.mockRejectedValue(new Error("PM tool down"));
		const r = await detectAndStampPmPushConflict(FAST_INPUT);
		expect(r.hasConflict).toBe(false);
		expect(stampPmSyncConflict).not.toHaveBeenCalled();
	});
});

describe("detectAndStampPmPushConflict — fallback (no caps / REST)", () => {
	it("delegates to previewPmSyncConflict + stamps on conflict", async () => {
		previewPmSyncConflict.mockResolvedValue({ hasConflict: true });
		const r = await detectAndStampPmPushConflict(FALLBACK_INPUT);
		expect(r.hasConflict).toBe(true);
		expect(previewPmSyncConflict).toHaveBeenCalledTimes(1);
		expect(fetchPmTicket).not.toHaveBeenCalled(); // fast path not taken
		expect(stampPmSyncConflict).toHaveBeenCalledWith("story", "s1");
	});

	it("delegates + does not stamp when no conflict", async () => {
		previewPmSyncConflict.mockResolvedValue({ hasConflict: false });
		const r = await detectAndStampPmPushConflict(FALLBACK_INPUT);
		expect(r.hasConflict).toBe(false);
		expect(stampPmSyncConflict).not.toHaveBeenCalled();
	});

	it("does not stamp for non-story/bug item types", async () => {
		previewPmSyncConflict.mockResolvedValue({ hasConflict: true });
		const r = await detectAndStampPmPushConflict({
			...FALLBACK_INPUT,
			itemType: "feature",
		});
		expect(r.hasConflict).toBe(true);
		expect(stampPmSyncConflict).not.toHaveBeenCalled();
	});
});
