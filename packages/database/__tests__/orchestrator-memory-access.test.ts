import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	turnCounts: vi.fn(),
	preferences: vi.fn(),
	projectAccess: vi.fn(),
	workspaceAccess: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		conversationTurn: { groupBy: mocks.turnCounts },
		episodicMemory: { findMany: mocks.findMany },
		orchestratorMemoryPreferences: { findFirst: mocks.preferences },
	},
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: mocks.projectAccess,
}));
vi.mock("../prisma/queries/workspaces/workspaces", () => ({
	hasWorkspaceAccess: mocks.workspaceAccess,
}));

import {
	buildOrchestratorMemoryContext,
	type EpisodeSummary,
	filterAccessibleMemoryScopes,
	getProjectEpisodes,
	getRecentEpisodes,
	getWorkspaceEpisodes,
	renderOrchestratorMemoryContext,
	searchEpisodicMemories,
} from "../prisma/queries/orchestrator-memory";

function episode(
	id: string,
	projectId: string | null = null,
	workspaceId: string | null = null,
): EpisodeSummary {
	return {
		id,
		projectId,
		workspaceId,
		qdrantPointId: null,
		conversationId: `conversation-${id}`,
		title: "Example discussion",
		summary: "Example summary",
		keyTopics: [],
		userIntents: [],
		outcome: "success",
		messageCount: 2,
		turnCount: 1,
		toolsUsed: [],
		agentsUsed: [],
		conversationStartedAt: new Date("2026-10-01"),
		conversationEndedAt: new Date("2026-10-02"),
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findMany.mockResolvedValue([]);
	mocks.turnCounts.mockResolvedValue([]);
	mocks.preferences.mockResolvedValue({
		preferences: {},
		recentProjectIds: [],
		recentWorkspaceIds: [],
	});
	mocks.projectAccess.mockResolvedValue(true);
	mocks.workspaceAccess.mockResolvedValue(true);
});

const readers = {
	recent: () => getRecentEpisodes("example-user", "example-org"),
	project: () =>
		getProjectEpisodes("example-project", "example-user", "example-org"),
	workspace: () =>
		getWorkspaceEpisodes(
			"example-workspace",
			"example-user",
			"example-org",
		),
	search: () =>
		searchEpisodicMemories({
			userId: "example-user",
			organizationId: "example-org",
		}),
};

describe.each(Object.entries(readers))("%s episode access", (_name, read) => {
	it("drops revoked projects and workspaces, checks distinct ids once, and keeps unscoped episodes", async () => {
		mocks.findMany.mockResolvedValue([
			episode("revoked-project", "revoked"),
			episode("revoked-workspace", null, "revoked"),
			episode("allowed", "allowed", "allowed"),
			episode("same-project", "allowed"),
			episode("unscoped"),
		]);
		mocks.projectAccess.mockImplementation(
			async (id: string) => id !== "revoked",
		);
		mocks.workspaceAccess.mockImplementation(
			async (id: string) => id !== "revoked",
		);
		expect((await read()).map((row) => row.id)).toEqual([
			"allowed",
			"same-project",
			"unscoped",
		]);
		expect(mocks.projectAccess).toHaveBeenCalledTimes(2);
		expect(mocks.workspaceAccess).toHaveBeenCalledTimes(2);
	});

	it("drops episodes when a project or workspace check throws", async () => {
		mocks.findMany.mockResolvedValue([
			episode("project-error", "unavailable"),
			episode("workspace-error", null, "unavailable"),
			episode("unscoped"),
		]);
		mocks.projectAccess.mockRejectedValue(new Error("access unavailable"));
		mocks.workspaceAccess.mockRejectedValue(
			new Error("access unavailable"),
		);
		expect((await read()).map((row) => row.id)).toEqual(["unscoped"]);
	});
});

describe("semantic hit hydration", () => {
	it.each(["example-org", null])(
		"loads database episode ids with the exclusive user/tenant filter (%s)",
		async (organizationId) => {
			const ids = ["second", "revoked", "first"];
			mocks.findMany.mockImplementation(async ({ where }) =>
				where.id
					? [
							episode("first"),
							episode("revoked", "revoked"),
							episode("second"),
						]
					: [],
			);
			mocks.projectAccess.mockResolvedValue(false);
			const context = await buildOrchestratorMemoryContext({
				userId: "example-user",
				organizationId,
				relevantEpisodeIds: ids,
			});
			expect(mocks.findMany).toHaveBeenCalledWith({
				where: {
					id: { in: ids },
					userId: "example-user",
					organizationId,
				},
			});
			expect(context.relevantEpisodes.map((row) => row.id)).toEqual([
				"second",
				"first",
			]);
		},
	);

	it("fails closed on access errors while hydrating semantic hits", async () => {
		mocks.findMany.mockImplementation(async ({ where }) =>
			where.id ? [episode("error", "unavailable"), episode("safe")] : [],
		);
		mocks.projectAccess.mockRejectedValue(new Error("access unavailable"));
		const context = await buildOrchestratorMemoryContext({
			userId: "example-user",
			organizationId: "example-org",
			relevantEpisodeIds: ["error", "safe"],
		});
		expect(context.relevantEpisodes.map((row) => row.id)).toEqual(["safe"]);
	});
});

describe("memory scope workspace arrays", () => {
	it("requires access to each attached workspace and deduplicates across scope forms", async () => {
		const rows = [
			{
				id: "denied",
				workspaceIds: ["example-allowed", "example-denied"],
			},
			{
				id: "allowed",
				projectId: "example-project",
				workspaceId: "example-allowed",
				workspaceIds: ["example-allowed"],
			},
			{ id: "unscoped", workspaceIds: [] },
		];
		mocks.workspaceAccess.mockImplementation(
			async (id: string) => id !== "example-denied",
		);
		expect(
			await filterAccessibleMemoryScopes(
				rows,
				"example-user",
				"example-org",
			),
		).toEqual(rows.slice(1));
		expect(mocks.projectAccess).toHaveBeenCalledTimes(1);
		expect(mocks.workspaceAccess).toHaveBeenCalledTimes(2);
	});
});

describe("recorded turns for repeat collapse", () => {
	const question = "Do the same for the next one";
	const row = (id: string, day: number) => ({
		...episode(id, "example-project", "example-workspace"),
		title: question,
		summary: `${id} outcome`,
		conversationEndedAt: new Date(`2026-10-${day}`),
	});
	it.each([
		{
			name: "two multi-turn follow-ups",
			counts: [2, 3],
			expected: ["match", "new"],
		},
		{
			name: "single-turn and multi-turn follow-ups",
			counts: [1, 2],
			expected: ["match", "new"],
		},
		{
			name: "a missing turn record",
			counts: [1, undefined],
			expected: ["match", "new"],
		},
		{
			name: "no turn records",
			counts: [undefined, undefined],
			expected: ["match", "new"],
		},
		{ name: "single-turn repeats", counts: [1, 1], expected: ["new"] },
		{
			name: "a multi-turn member beside two single-turn members",
			counts: [1, 1, 2],
			expected: ["match", "new", "third"],
		},
	])("selects safely for $name", async ({ counts, expected }) => {
		const rows = [
			row("match", 16),
			row("new", 19),
			...(counts.length === 3 ? [row("third", 18)] : []),
		];
		mocks.findMany.mockImplementation(async ({ where }) =>
			where.id ? rows : [],
		);
		mocks.turnCounts.mockResolvedValue(
			rows.flatMap((episode, i) =>
				counts[i] === undefined
					? []
					: [
							{
								conversationId: episode.conversationId,
								_count: { _all: counts[i] },
							},
						],
			),
		);
		const context = await buildOrchestratorMemoryContext({
			userId: "example-user",
			organizationId: "example-org",
			relevantEpisodeIds: rows.map((episode) => episode.id),
		});
		const result = await renderOrchestratorMemoryContext(context);
		expect(
			result.context.relevantEpisodes.map((episode) => episode.id),
		).toEqual(expected);
		if (expected[0] === "match") {
			expect(result.text.indexOf("match outcome")).toBeGreaterThan(-1);
			expect(result.text.indexOf("match outcome")).toBeLessThan(
				result.text.indexOf("new outcome"),
			);
		}
	});

	it("batches candidate conversation counts once with the memory load's owner and tenant", async () => {
		const rows = [
			row("match", 16),
			row("new", 19),
			{ ...row("short-a", 16), title: "yes" },
			{ ...row("short-b", 19), title: "yes" },
			{ ...row("other-scope", 19), projectId: "example-other-project" },
			{
				...row("unique", 19),
				title: "List the example project reports today",
			},
		];
		// Overlap between retrieval sections must not multiply queries or IDs.
		mocks.findMany.mockResolvedValue(rows);
		mocks.turnCounts.mockResolvedValue([
			{ conversationId: "conversation-match", _count: { _all: 1 } },
			{ conversationId: "conversation-new", _count: { _all: 1 } },
		]);
		const context = await buildOrchestratorMemoryContext({
			userId: "example-user",
			organizationId: "example-org",
			relevantEpisodeIds: rows.map((episode) => episode.id),
		});
		expect(mocks.turnCounts).toHaveBeenCalledTimes(1);
		expect(mocks.turnCounts).toHaveBeenCalledWith({
			by: ["conversationId"],
			where: {
				conversationId: {
					in: ["conversation-match", "conversation-new"],
				},
				userId: "example-user",
				organizationId: "example-org",
			},
			_count: { _all: true },
		});
		const result = await renderOrchestratorMemoryContext(context);
		expect(
			result.context.relevantEpisodes.map((episode) => episode.id),
		).toEqual(["new", "short-a", "short-b", "other-scope", "unique"]);
	});
});
