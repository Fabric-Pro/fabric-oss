import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	search: vi.fn(),
	ensureCollection: vi.fn(),
}));
vi.mock("../client", () => ({ qdrantClient: { search: mocks.search } }));
vi.mock("../../collection-manager", () => ({
	ensureCollection: mocks.ensureCollection,
}));
vi.mock("../../utils", () => ({ generatePointId: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { searchSimilarEpisodes } from "../episodic-memory-store";
import { searchSimilarExecutions } from "../orchestrator-memory";

const user = { key: "userId", match: { value: "example-user" } };
const org = { key: "organizationId", match: { value: "example-org" } };
const emptyOrg = { is_empty: { key: "organizationId" } };
const options = { queryEmbedding: [0.1, 0.2], userId: "example-user" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.ensureCollection.mockResolvedValue("example-memory");
	mocks.search.mockResolvedValue([]);
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
