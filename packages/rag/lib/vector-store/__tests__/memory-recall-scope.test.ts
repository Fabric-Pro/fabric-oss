import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	search: vi.fn(),
	upsert: vi.fn(),
	projectAccess: vi.fn(),
	workspaceAccess: vi.fn(),
	ensureCollection: vi.fn(),
}));
vi.mock("../client", () => ({
	qdrantClient: { search: mocks.search, upsert: mocks.upsert },
}));
vi.mock("../../collection-manager", () => ({
	ensureCollection: mocks.ensureCollection,
}));
vi.mock("../../utils", () => ({ generatePointId: vi.fn() }));
vi.mock("@repo/database", async () => {
	const actual = await import(
		"@repo/database/prisma/queries/orchestrator-memory"
	);
	return {
		filterAccessibleMemoryScopes: actual.filterAccessibleMemoryScopes,
	};
});
vi.mock("@repo/database/prisma/client", () => ({ db: {} }));
vi.mock("@repo/database/prisma/queries/projects/projects", () => ({
	hasProjectAccess: mocks.projectAccess,
}));
vi.mock("@repo/database/prisma/queries/workspaces/workspaces", () => ({
	hasWorkspaceAccess: mocks.workspaceAccess,
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { searchSimilarEpisodes } from "../episodic-memory-store";
import {
	searchSimilarExecutions,
	storeExecutionSummary,
} from "../orchestrator-memory";

const user = { key: "userId", match: { value: "example-user" } };
const org = { key: "organizationId", match: { value: "example-org" } };
const emptyOrg = { is_empty: { key: "organizationId" } };
const options = { queryEmbedding: [0.1, 0.2], userId: "example-user" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.ensureCollection.mockResolvedValue("example-memory");
	mocks.search.mockResolvedValue([]);
	mocks.upsert.mockResolvedValue({});
	mocks.projectAccess.mockResolvedValue(true);
	mocks.workspaceAccess.mockResolvedValue(true);
});

function filter() {
	return mocks.search.mock.calls[0][1].filter;
}

describe("per-user memory vector filters", () => {
	it("requires both organization and requesting user for episodes", async () => {
		await searchSimilarEpisodes({
			...options,
			organizationId: "example-org",
		});
		expect(filter().must).toEqual(expect.arrayContaining([org, user]));
	});

	it("excludes organization episodes in the personal arm", async () => {
		await searchSimilarEpisodes(options);
		expect(filter().must).toEqual([user, emptyOrg]);
	});

	it("requires each requested scope or an unscoped episode, preserving agent and exclusions", async () => {
		await searchSimilarEpisodes({
			...options,
			organizationId: "example-org",
			projectId: "example-project",
			workspaceId: "example-workspace",
			agentId: "example-agent",
			excludeConversationIds: ["example-conversation"],
		});
		expect(filter().must).toEqual(
			expect.arrayContaining([
				org,
				user,
				{
					should: [
						{
							key: "projectId",
							match: { value: "example-project" },
						},
						{ is_empty: { key: "projectId" } },
					],
				},
				{
					should: [
						{
							key: "workspaceId",
							match: { value: "example-workspace" },
						},
						{ is_empty: { key: "workspaceId" } },
					],
				},
				{ key: "agentId", match: { value: "example-agent" } },
			]),
		);
		expect(filter()).not.toHaveProperty("should");
		expect(filter().must_not).toEqual([
			{ key: "conversationId", match: { any: ["example-conversation"] } },
		]);
	});

	it("requires both organization and requesting user for executions", async () => {
		await searchSimilarExecutions({
			...options,
			organizationId: "example-org",
		});
		expect(filter().must).toEqual(expect.arrayContaining([org, user]));
	});
});

describe("execution summary access scopes", () => {
	it.each([true, false])(
		"writes a marked summary with attached scopes (%s)",
		async (scoped) => {
			await storeExecutionSummary({
				execution: {
					id: "example-run",
					taskDescription: "Example task",
					taskHash: "example-hash",
					summary: "Example summary",
					agentsUsed: [],
					toolsUsed: [],
					outcome: "success",
					durationMs: 1,
					stepCount: 1,
					userId: "example-user",
					organizationId: "example-org",
					...(scoped
						? {
								projectId: "example-project",
								workspaceIds: ["example-workspace"],
							}
						: {}),
					timestamp: "2026-10-22",
				},
				embedding: [0.1],
			});
			expect(
				mocks.upsert.mock.calls[0][1].points[0].payload,
			).toMatchObject({
				...(scoped ? { projectId: "example-project" } : {}),
				workspaceIds: scoped ? ["example-workspace"] : [],
				accessScopeVersion: 1,
			});
		},
	);

	it("requires the access scope version to exclude legacy points at source", async () => {
		await searchSimilarExecutions(options);
		expect(filter().must).toContainEqual({
			key: "accessScopeVersion",
			match: { value: 1 },
		});
	});

	it.each([
		"project-revoked",
		"workspace-revoked",
		"project-error",
		"workspace-error",
	])(
		"drops a summary with %s and keeps accessible and marked unscoped summaries",
		async (failure) => {
			const projectId = "example-project";
			const workspaceIds = [
				"example-workspace",
				"example-other-workspace",
			];
			mocks.search.mockResolvedValue([
				{
					score: 0.9,
					payload: {
						executionId: "denied",
						projectId,
						workspaceIds,
						accessScopeVersion: 1,
					},
				},
				{
					score: 0.8,
					payload: {
						executionId: "allowed",
						projectId: "example-allowed-project",
						workspaceIds: ["example-allowed-workspace"],
						accessScopeVersion: 1,
					},
				},
				{
					score: 0.7,
					payload: {
						executionId: "unscoped",
						workspaceIds: [],
						accessScopeVersion: 1,
					},
				},
				{
					score: 0.6,
					payload: {
						executionId: "same-scope",
						projectId,
						workspaceIds,
						accessScopeVersion: 1,
					},
				},
			]);
			mocks.projectAccess.mockImplementation(async (id: string) => {
				if (id === projectId && failure === "project-error") {
					throw new Error("unavailable");
				}
				return id !== projectId || failure !== "project-revoked";
			});
			mocks.workspaceAccess.mockImplementation(async (id: string) => {
				if (id === workspaceIds[1] && failure === "workspace-error") {
					throw new Error("unavailable");
				}
				return (
					id !== workspaceIds[1] || failure !== "workspace-revoked"
				);
			});
			const result = await searchSimilarExecutions({
				...options,
				organizationId: "example-org",
			});
			expect(result.map((r) => r.execution.id)).toEqual([
				"allowed",
				"unscoped",
			]);
			expect(mocks.projectAccess).toHaveBeenCalledTimes(2);
			expect(mocks.projectAccess).toHaveBeenCalledWith(
				projectId,
				"example-user",
				"example-org",
			);
			expect(mocks.workspaceAccess).toHaveBeenCalledTimes(3);
			expect(mocks.workspaceAccess).toHaveBeenCalledWith(
				workspaceIds[1],
				"example-user",
			);
		},
	);
});

it.each(
	[undefined, null, "example-workspace", ["example-workspace", 123], {}].map(
		(value) => [value],
	),
)(
	"drops only a point with malformed workspaceIds (%j)",
	async (workspaceIds) => {
		mocks.search.mockResolvedValue([
			{
				score: 0.9,
				payload: {
					executionId: "malformed",
					workspaceIds,
					accessScopeVersion: 1,
				},
			},
			{
				score: 0.8,
				payload: {
					executionId: "allowed",
					workspaceIds: [],
					accessScopeVersion: 1,
				},
			},
		]);
		expect(
			(await searchSimilarExecutions(options)).map((r) => r.execution.id),
		).toEqual(["allowed"]);
	},
);
