/**
 * QdrantToolUsageStore — tenant isolation on the shared
 * `fabric_orchestrator_memory` collection.
 *
 * Every tenant's tool calls live in one collection. The payload carries
 * `userId` / `organizationId`, but the searches used to filter only on
 * `type` / `toolId` / `success`, so organization A's past calls (and the
 * argument suggestions built from them) surfaced for organization B. Both
 * search paths must carry the repo's XOR tenant filter, and a personal-context
 * search must never match rows written inside an organization.
 *
 * Run with: pnpm --filter @repo/temporal test -- qdrant-tool-store
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ragMocks = vi.hoisted(() => ({
	search: vi.fn(),
	retrieve: vi.fn(),
	upsert: vi.fn(),
	generateEmbedding: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	ORCHESTRATOR_MEMORY_COLLECTION: "fabric_orchestrator_memory",
	qdrantClient: {
		search: ragMocks.search,
		retrieve: ragMocks.retrieve,
		upsert: ragMocks.upsert,
	},
	generateEmbedding: ragMocks.generateEmbedding,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { QdrantToolUsageStore } from "../qdrant-tool-store";

type Condition =
	| { key: string; match: { value: string | boolean } }
	| { is_empty: { key: string } };

/**
 * Minimal evaluator for the `must` conditions this store emits, so the tests
 * assert what the filter *means* against concrete rows rather than only its
 * shape. Mirrors Qdrant semantics: `match` is equality on the payload key,
 * `is_empty` is true when the key is absent/null.
 */
function rowMatches(row: Record<string, unknown>, must: Condition[]): boolean {
	return must.every((condition) => {
		if ("is_empty" in condition) {
			const value = row[condition.is_empty.key];
			return value === undefined || value === null;
		}
		return row[condition.key] === condition.match.value;
	});
}

const orgRow = {
	type: "tool_call",
	toolId: "github.create_issue",
	success: true,
	userId: "user-1",
	organizationId: "org-a",
	context: "org-a context",
	args: { repo: "org-a/private" },
};
const otherOrgRow = {
	...orgRow,
	organizationId: "org-b",
	context: "org-b context",
	args: { repo: "org-b/private" },
};
const personalRow = {
	type: "tool_call",
	toolId: "github.create_issue",
	success: true,
	userId: "user-1",
	context: "personal context",
	args: { repo: "user-1/personal" },
};
const otherUserPersonalRow = {
	...personalRow,
	userId: "user-2",
	args: { repo: "user-2/personal" },
};

function lastSearchMust(): Condition[] {
	const calls = ragMocks.search.mock.calls;
	const [, params] = calls[calls.length - 1];
	return params.filter.must as Condition[];
}

beforeEach(() => {
	vi.clearAllMocks();
	ragMocks.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
	ragMocks.search.mockResolvedValue([]);
	ragMocks.retrieve.mockResolvedValue([]);
});

describe("QdrantToolUsageStore.queryLearnings", () => {
	it("filters on organizationId in an organization context", async () => {
		const store = new QdrantToolUsageStore("key", {
			userId: "user-1",
			organizationId: "org-a",
		});

		await store.queryLearnings({
			toolId: "github.create_issue",
			taskContext: "open an issue",
		});

		const must = lastSearchMust();
		expect(must).toContainEqual({
			key: "organizationId",
			match: { value: "org-a" },
		});
		expect(must).toContainEqual({
			key: "type",
			match: { value: "tool_call" },
		});
		expect(must).toContainEqual({
			key: "toolId",
			match: { value: "github.create_issue" },
		});
		expect(must).toContainEqual({ key: "success", match: { value: true } });

		expect(rowMatches(orgRow, must)).toBe(true);
		expect(rowMatches(otherOrgRow, must)).toBe(false);
		expect(rowMatches(personalRow, must)).toBe(false);
	});

	it("filters on userId AND no organizationId in a personal context", async () => {
		const store = new QdrantToolUsageStore("key", { userId: "user-1" });

		await store.queryLearnings({
			toolId: "github.create_issue",
			taskContext: "open an issue",
		});

		const must = lastSearchMust();
		expect(must).toContainEqual({
			key: "userId",
			match: { value: "user-1" },
		});
		expect(must).toContainEqual({ is_empty: { key: "organizationId" } });
		expect(must.some((c) => "key" in c && c.key === "organizationId")).toBe(
			false,
		);

		// The user's own organization rows must not leak into personal context.
		expect(rowMatches(personalRow, must)).toBe(true);
		expect(rowMatches(orgRow, must)).toBe(false);
		expect(rowMatches(otherOrgRow, must)).toBe(false);
		expect(rowMatches(otherUserPersonalRow, must)).toBe(false);
	});

	it("looks the aggregated pattern up under a per-user id in personal context, not a shared bucket", async () => {
		const store = new QdrantToolUsageStore("key", { userId: "user-1" });

		await store.queryLearnings({
			toolId: "github.create_issue",
			taskContext: "open an issue",
		});

		expect(ragMocks.retrieve).toHaveBeenCalledWith(
			"fabric_orchestrator_memory",
			expect.objectContaining({
				ids: ["tool-pattern-github.create_issue-user-user-1"],
			}),
		);
	});

	it("keeps the historical organization-scoped pattern id", async () => {
		const store = new QdrantToolUsageStore("key", {
			userId: "user-1",
			organizationId: "org-a",
		});

		await store.getPattern("github.create_issue");

		expect(ragMocks.retrieve).toHaveBeenCalledWith(
			"fabric_orchestrator_memory",
			expect.objectContaining({
				ids: ["tool-pattern-github.create_issue-org-a"],
			}),
		);
	});
});

describe("QdrantToolUsageStore.searchSimilarContexts", () => {
	it("carries the organization condition alongside type/toolId", async () => {
		const store = new QdrantToolUsageStore("key", {
			userId: "user-1",
			organizationId: "org-a",
		});

		await store.searchSimilarContexts(
			"open an issue",
			"github.create_issue",
		);

		const must = lastSearchMust();
		expect(must).toContainEqual({
			key: "organizationId",
			match: { value: "org-a" },
		});
		expect(must).toContainEqual({
			key: "type",
			match: { value: "tool_call" },
		});
		expect(must).toContainEqual({
			key: "toolId",
			match: { value: "github.create_issue" },
		});
		expect(rowMatches(orgRow, must)).toBe(true);
		expect(rowMatches(otherOrgRow, must)).toBe(false);
	});

	it("in personal context matches only the user's organization-less rows", async () => {
		const store = new QdrantToolUsageStore("key", { userId: "user-1" });

		await store.searchSimilarContexts("open an issue");

		const must = lastSearchMust();
		expect(must).toContainEqual({
			key: "userId",
			match: { value: "user-1" },
		});
		expect(must).toContainEqual({ is_empty: { key: "organizationId" } });

		expect(rowMatches(personalRow, must)).toBe(true);
		expect(rowMatches(orgRow, must)).toBe(false);
		expect(rowMatches(otherOrgRow, must)).toBe(false);
		expect(rowMatches(otherUserPersonalRow, must)).toBe(false);
	});
});

describe("QdrantToolUsageStore.getPattern", () => {
	it("discards a retrieved pattern whose payload belongs to another tenant", async () => {
		ragMocks.retrieve.mockResolvedValue([
			{
				id: "tool-pattern-github.create_issue-org-a",
				payload: {
					type: "tool_pattern",
					toolId: "github.create_issue",
					userId: "user-9",
					organizationId: "org-b",
					pattern: { toolId: "github.create_issue" },
				},
			},
		]);
		const store = new QdrantToolUsageStore("key", {
			userId: "user-1",
			organizationId: "org-a",
		});

		expect(await store.getPattern("github.create_issue")).toBeNull();
	});

	it("returns a pattern that belongs to this tenant", async () => {
		ragMocks.retrieve.mockResolvedValue([
			{
				id: "tool-pattern-github.create_issue-org-a",
				payload: {
					type: "tool_pattern",
					toolId: "github.create_issue",
					userId: "user-1",
					organizationId: "org-a",
					pattern: { toolId: "github.create_issue" },
				},
			},
		]);
		const store = new QdrantToolUsageStore("key", {
			userId: "user-1",
			organizationId: "org-a",
		});

		expect(await store.getPattern("github.create_issue")).toEqual({
			toolId: "github.create_issue",
		});
	});
});

describe("QdrantToolUsageStore.recordCall (write path)", () => {
	it("stores both userId and organizationId on the tool-call payload", async () => {
		const store = new QdrantToolUsageStore("key", {
			userId: "user-1",
			organizationId: "org-a",
		});

		await store.recordCall({
			toolId: "github.create_issue",
			toolName: "create_issue",
			args: { repo: "org-a/private" },
			context: "open an issue",
			result: { success: true, durationMs: 10 },
			timestamp: new Date("2026-09-13T00:00:00.000Z"),
			userId: "user-1",
			organizationId: "org-a",
		});

		const [, firstUpsert] = ragMocks.upsert.mock.calls[0];
		expect(firstUpsert.points[0].payload).toMatchObject({
			type: "tool_call",
			userId: "user-1",
			organizationId: "org-a",
		});
	});
});
