import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	project: { update: vi.fn(), findUnique: vi.fn() },
	mCPServer: { findUnique: vi.fn() },
}));
const links = vi.hoisted(() => ({ getLinkedExternalIds: vi.fn() }));
const { resolvePmServerKey } = vi.hoisted(() => ({
	resolvePmServerKey: vi.fn(),
}));
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
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice(4),
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
	resolvePmServerKey,
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

const linkRow = (
	externalId: string,
	externalMcpServerId: string | null,
	externalUrl: string | null,
) => ({
	entityType: "STORY",
	entityId: `story-${externalId}`,
	externalId,
	draftingStage: "DRAFT",
	pmAutoHidden: false,
	lastSyncedPmHash: null,
	lastPmSyncStatus: null,
	externalMcpServerId,
	externalUrl,
});

const gitlabInput = {
	...baseInput,
	mcpConfigId: null,
	mcpServerId: "srv-gl",
	pmTool: "gitlab-official",
	sourceKind: "rest-gitlab" as const,
};

const requestedIds = () =>
	[
		...((story.fetchPMItemsByIds.mock.calls[0]?.[0]
			?.externalIds as string[]) ?? []),
	].sort();

describe("fetchAdoWorkItemStates — reads only stories linked to the active PM tool", () => {
	beforeEach(() => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-1",
			pmTerminalStatuses: null,
			pmStatusSyncEnabled: false,
			pmStatusSyncSessionAt: null,
		});
		dbMock.mCPServer.findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				(
					({
						"srv-gl": { key: "gitlab-official" },
						"srv-gl-old": { key: "gitlab" },
						"srv-fz": { key: "fizzy" },
					}) as Record<string, { key: string }>
				)[where.id] ?? null,
		);
		links.getLinkedExternalIds.mockResolvedValue([
			linkRow(
				"1",
				"srv-gl",
				"https://gitlab.com/acme/portal/-/work_items/1",
			),
			linkRow(
				"2",
				"srv-gl-old",
				"https://gitlab.com/acme/portal/-/issues/2",
			), // same tool, older server row
			linkRow("3", null, "https://gitlab.com/acme/portal/-/issues/3"), // import-created, unstamped
			linkRow("4", null, null), // no provenance at all
			linkRow("1541", "srv-fz", "https://app.fizzy.do/1/cards/1541"), // previous PM tool
			linkRow("1692", null, "https://app.fizzy.do/1/cards/1692"), // previous tool, unstamped
			linkRow("77", "srv-gone", "https://app.fizzy.do/1/cards/77"), // deleted server row, Fizzy URL
		]);
		// Model the real failure mode: another tool's ids fail when requested.
		// If every requested id succeeded, `res.complete` would pass whether or
		// not the active-tool filter ran (unfiltered: 7 requested, 7 seen).
		// They are TRANSIENT failures here, never not-found — the staging read
		// of a Fizzy card number from GitLab threw rather than answering
		// "no such issue".
		const OTHER_TOOL_IDS = new Set(["1541", "1692", "77"]);
		story.fetchPMItemsByIds.mockImplementation(
			async ({ externalIds }: { externalIds: string[] }) => {
				const ok = externalIds.filter((id) => !OTHER_TOOL_IDS.has(id));
				const failed = externalIds.filter((id) =>
					OTHER_TOOL_IDS.has(id),
				);
				return {
					items: ok.map((id) => ({
						id,
						title: `T${id}`,
						description: "d",
					})),
					total: ok.length,
					hasNextPage: false,
					failedIds: failed,
					notFoundIds: [],
				};
			},
		);
	});
	afterEach(() => vi.clearAllMocks());

	it("never requests another tool's ids, and completes when every active-tool link is read", async () => {
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		const res = await fetchAdoWorkItemStates(gitlabInput);

		expect(requestedIds()).toEqual(["1", "2", "3", "4"]);
		expect(res.totalLinked).toBe(4);
		expect(res.complete).toBe(true);
		expect(story.fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({ requireFreshToken: true }),
		);
	});

	it("an input recorded without pmTool scopes from its mcpServerId snapshot", async () => {
		resolvePmServerKey.mockResolvedValue("gitlab-official");
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		await fetchAdoWorkItemStates({ ...gitlabInput, pmTool: undefined });

		expect(resolvePmServerKey).toHaveBeenCalledWith("srv-gl");
		expect(requestedIds()).toEqual(["1", "2", "3", "4"]);
	});

	it("a null pmTool (explicitly unknown) still scopes from its mcpServerId snapshot", async () => {
		resolvePmServerKey.mockResolvedValue("gitlab-official");
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		await fetchAdoWorkItemStates({ ...gitlabInput, pmTool: null });

		expect(resolvePmServerKey).toHaveBeenCalledWith("srv-gl");
		expect(requestedIds()).toEqual(["1", "2", "3", "4"]);
	});

	it("positive control: an unknown active tool type reads every linked story, as before", async () => {
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		await fetchAdoWorkItemStates({
			...gitlabInput,
			pmTool: null,
			mcpServerId: undefined,
		});

		expect(requestedIds()).toHaveLength(7);
		expect(dbMock.mCPServer.findUnique).not.toHaveBeenCalled();
		expect(resolvePmServerKey).not.toHaveBeenCalled();
	});

	it("every linked story belongs to another tool: nothing is requested, and the fetch still reports complete", async () => {
		links.getLinkedExternalIds.mockResolvedValue([
			linkRow("1541", "srv-fz", "https://app.fizzy.do/1/cards/1541"), // previous PM tool
			linkRow("1692", null, "https://app.fizzy.do/1/cards/1692"), // previous tool, unstamped
		]);
		const { fetchAdoWorkItemStates } = await import("../pm-state-poll");
		const res = await fetchAdoWorkItemStates(gitlabInput);

		expect(story.fetchPMItemsByIds).not.toHaveBeenCalled();
		expect(res.totalLinked).toBe(0);
		expect(res.complete).toBe(true);
	});
});
