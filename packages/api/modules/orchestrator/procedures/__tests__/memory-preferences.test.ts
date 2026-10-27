import { os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteRow: vi.fn(),
	page: vi.fn(),
	recent: vi.fn(),
	deleteVector: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("@repo/database", async () => ({
	...(await import("@repo/database/src/tenant-context")),
	deleteEpisodicMemory: mocks.deleteRow,
	getOrchestratorMemoryPreferences: vi.fn(),
	getRecentEpisodes: mocks.recent,
	getEpisodesPage: mocks.page,
	removeLearnedPattern: vi.fn(),
	searchEpisodicMemories: vi.fn(),
	updateOrchestratorMemoryPreferences: vi.fn(),
}));
vi.mock("@repo/rag/lib/vector-store/episodic-memory-store", () => ({
	deleteEpisodeEmbedding: mocks.deleteVector,
}));
vi.mock("@repo/logs", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: os.$context<{
		user: { id: string };
		session: { activeOrganizationId: string };
	}>(),
	requireInputOrgPermission: () => os.middleware(async ({ next }) => next()),
	Permissions: { AGENT_READ: "agent.read", AGENT_UPDATE: "agent.update" },
	resolveOrganizationId: (
		_input: unknown,
		session: { activeOrganizationId: string },
	) => session.activeOrganizationId,
}));

import { deleteEpisode, getEpisodes } from "../memory-preferences";

const invoke = () =>
	deleteEpisode["~orpc"].handler({
		input: {
			episodeId: "episode-example",
			organizationId: "example-untrusted-org",
		},
		context: {
			user: { id: "user-example-1" },
			session: { activeOrganizationId: "example-org" },
			memoryOrganizationId: "example-org",
		},
	});
beforeEach(() => {
	vi.resetAllMocks();
	mocks.recent.mockResolvedValue([]);
	mocks.deleteRow.mockResolvedValue(true);
	mocks.deleteVector.mockResolvedValue(true);
});
describe("deleteEpisode vector cleanup", () => {
	it.each(["success", "false", "throws"])(
		"cleans the resolved tenant vector and preserves successful deletion (%s)",
		async (scenario) => {
			if (scenario === "false") {
				mocks.deleteVector.mockResolvedValue(false);
			}
			if (scenario === "throws") {
				mocks.deleteVector.mockRejectedValue(
					new Error("Qdrant unavailable"),
				);
			}
			expect(await invoke()).toEqual({
				success: true,
				message: "Episode deleted",
			});
			expect(mocks.deleteRow).toHaveBeenCalledWith(
				"episode-example",
				"user-example-1",
				"example-org",
			);
			expect(mocks.deleteVector).toHaveBeenCalledWith(
				"episode-example",
				"example-org",
			);
			expect(
				mocks.deleteVector.mock.invocationCallOrder[0],
			).toBeGreaterThan(mocks.deleteRow.mock.invocationCallOrder[0]);
			if (scenario !== "success") {
				expect(mocks.warn).toHaveBeenCalled();
			}
		},
	);
	it("skips vector deletion when the row was absent or inaccessible", async () => {
		await invoke();
		expect(mocks.deleteVector).toHaveBeenCalledWith(
			"episode-example",
			"example-org",
		);
		mocks.deleteVector.mockClear();
		mocks.deleteRow.mockResolvedValue(false);
		expect(await invoke()).toEqual({
			success: false,
			message: "Episode not found or access denied",
		});
		expect(mocks.deleteVector).not.toHaveBeenCalled();
	});
});

it("passes the offset and resolved tenant through and returns the accessible total", async () => {
	mocks.page.mockResolvedValue({
		episodes: [{ id: "example-second-page" }],
		total: 23,
	});
	const result = await getEpisodes["~orpc"].handler({
		input: {
			organizationId: "example-untrusted-org",
			limit: 10,
			offset: 10,
		},
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: "example-org" },
			memoryOrganizationId: "example-org",
		},
	});
	expect(result).toEqual({
		episodes: [{ id: "example-second-page" }],
		total: 23,
	});
	expect(mocks.page).toHaveBeenCalledWith(
		"example-user",
		"example-org",
		10,
		10,
	);
});
