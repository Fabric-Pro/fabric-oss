import { afterEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ project: { update: vi.fn() } }));
vi.mock("@repo/database", () => ({
	db: dbMock,
	autoDismissReappearedFlagMissing: vi.fn(),
	createPmSyncConflictNotifications: vi.fn(),
	findFabricItemByExternalId: vi.fn(),
	findFabricItemsByExternalId: vi.fn(),
	getLinkedExternalIds: vi.fn(),
	incrementMissingStreak: vi.fn(),
	pendingFlagMissingExists: vi.fn(),
	recordAudit: vi.fn(),
	resetMissingStreaks: vi.fn(),
	upsertPendingChange: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Cut the heavy transitive import chain (story-sync pulls storage/mcp/integrations).
vi.mock("../story-sync", () => ({
	fetchPMItemsByIds: vi.fn(),
	getWorkItemsByIdsFromPM: vi.fn(),
}));
vi.mock("../../pm-source", () => ({
	resolvePmSource: vi.fn(),
	resolvePmServerKey: vi.fn(),
	PMSourceNotFound: class extends Error {},
}));

describe("updateProjectPollTimestamp advanceWatermark", () => {
	afterEach(() => vi.clearAllMocks());

	it("advances lastAdoStatePollAt when advanceWatermark is true", async () => {
		const { updateProjectPollTimestamp } = await import("../pm-state-poll");
		await updateProjectPollTimestamp("p1", true);
		expect(dbMock.project.update).toHaveBeenCalledTimes(1);
	});

	it("does NOT write when advanceWatermark is false (partial fetch)", async () => {
		const { updateProjectPollTimestamp } = await import("../pm-state-poll");
		await updateProjectPollTimestamp("p1", false);
		expect(dbMock.project.update).not.toHaveBeenCalled();
	});
});
