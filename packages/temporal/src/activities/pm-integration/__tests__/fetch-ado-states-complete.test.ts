import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	project: { update: vi.fn(), findUnique: vi.fn() },
}));
const links = vi.hoisted(() => ({ getLinkedExternalIds: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: dbMock,
	getLinkedExternalIds: links.getLinkedExternalIds,
	autoDismissReappearedFlagMissing: vi.fn(),
	createPmSyncConflictNotifications: vi.fn(),
	findFabricItemByExternalId: vi.fn(),
	findFabricItemsByExternalId: vi.fn(),
	incrementMissingStreak: vi.fn(),
	pendingFlagMissingExists: vi.fn(),
	recordAudit: vi.fn(),
	resetMissingStreaks: vi.fn(),
	upsertPendingChange: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const story = vi.hoisted(() => ({
	fetchPMItemsByIds: vi.fn(),
	getWorkItemsByIdsFromPM: vi.fn(),
}));
vi.mock("../story-sync", () => story);
vi.mock("../../pm-source", () => ({
	resolvePmSource: vi.fn(),
	resolvePmServerKey: vi.fn(),
	PMSourceNotFound: class extends Error {},
}));
vi.mock("../extract-pm-item-state", () => ({
	normalizePolledState: (item: { title?: string; description?: string }) => ({
		statusString: "Done",
		changedDate: null,
		title: item.title,
		description: item.description,
		isClosed: false,
		labels: [],
	}),
}));

const baseInput = {
	projectId: "p1",
	mcpConfigId: "cfg1",
	mcpServerId: "srv1",
	pmTool: "fizzy",
	sourceKind: "mcp" as const,
	containerId: "board1",
	containerName: null,
	lastAdoStatePollAt: null,
	userId: "u1",
};

describe("fetchAdoWorkItemStates.complete", () => {
	beforeEach(() =>
		links.getLinkedExternalIds.mockResolvedValue([
			{ externalId: "1" },
			{ externalId: "2" },
			{ externalId: "3" },
		]),
	);
	afterEach(() => vi.clearAllMocks());

	it("complete=true when every linked card is fetched", async () => {
		story.fetchPMItemsByIds.mockResolvedValue({
			items: [
				{ id: "1", title: "T1", description: "d" },
				{ id: "2", title: "T2", description: "d" },
				{ id: "3", title: "T3", description: "d" },
			],
			total: 3,
			hasNextPage: false,
			failedIds: [],
			notFoundIds: [],
		});
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		expect((await fetchAdoWorkItemStates(baseInput)).complete).toBe(true);
	});

	it("complete=false on a transient failure (also covers discovery-timeout shape)", async () => {
		story.fetchPMItemsByIds.mockResolvedValue({
			items: [
				{ id: "1", title: "T1", description: "d" },
				{ id: "3", title: "T3", description: "d" },
			],
			total: 2,
			hasNextPage: false,
			failedIds: ["2"],
			notFoundIds: [],
		});
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		expect((await fetchAdoWorkItemStates(baseInput)).complete).toBe(false);
	});

	it("complete=true when the shortfall is confirmed not-found (observed as gone)", async () => {
		story.fetchPMItemsByIds.mockResolvedValue({
			items: [
				{ id: "1", title: "T1", description: "d" },
				{ id: "2", title: "T2", description: "d" },
			],
			total: 2,
			hasNextPage: false,
			failedIds: ["3"],
			notFoundIds: ["3"],
		});
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		expect((await fetchAdoWorkItemStates(baseInput)).complete).toBe(true);
	});

	it("complete=true for an empty linked set (fetch not called)", async () => {
		links.getLinkedExternalIds.mockResolvedValue([]);
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		const res = await fetchAdoWorkItemStates(baseInput);
		expect(res.complete).toBe(true);
		expect(story.fetchPMItemsByIds).not.toHaveBeenCalled();
	});
});
