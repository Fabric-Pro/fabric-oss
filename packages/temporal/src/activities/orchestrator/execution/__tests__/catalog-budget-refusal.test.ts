/**
 * A token-allowance refusal raised deep inside a Fabric catalog tool leaves
 * the turn's activity as the non-retryable `TurnBudgetExhausted`, never as an
 * ordinary tool failure the loop would work around.
 *
 * Path under test: `code_search_semantic` through the catalog adapter
 * (`runFabricCatalogTool`) → the code-search step handler → the query
 * embedding, sent by a factory-wrapped embedding model whose reservation the
 * ledger refuses. Before, the adapter's catch turned the refusal into
 * `{ success: false, error }`.
 *
 * Also pins the backstop: inside a turn's guard, work that turned a refusal
 * into a value or into an ordinary error still fails with the refusal once
 * it has been latched on the guard.
 */

import { wrapEmbeddingModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import { wrapEmbeddingModelWithTurnBudget } from "@repo/ai/lib/turn-budget-middleware";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { embed } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	reserve: vi.fn(),
	embedRequests: 0,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
	reserveConversationTurnAttempt: h.reserve,
	settleConversationTurnAttempt: vi.fn(async () => ({
		outcome: "settled",
		status: "UNKNOWN",
	})),
	getConversationTurnLedgerSnapshot: vi.fn(async () => null),
	// One connected, readable repository with a searchable code index.
	db: {
		project: { findUnique: vi.fn(async () => null) },
		workflowIntegration: { findFirst: vi.fn(async () => null) },
	},
	// The handler rechecks project access per call; the user may read it.
	getProjectAccessContext: vi.fn(async () => ({
		organizationId: "org-example-1",
	})),
	getProjectCodeIndexes: vi.fn(async () => [{ status: "READY" }]),
	getProjectReposForCodeSearch: vi.fn(async () => [
		{
			provider: "GITHUB",
			owner: "example-org",
			repo: "app",
			branch: "main",
		},
	]),
	parseRepoUrl: vi.fn(),
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn(async () => ({
		token: "token-example",
		method: "pat",
	})),
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: vi.fn(),
}));

// The query embedding goes through the factory's embedding wrappers, as
// `generateEmbedding` does for a real tenant.
vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbedding: vi.fn(async (query: string) => {
		const model = wrapEmbeddingModelWithDispatchGuard(
			wrapEmbeddingModelWithTurnBudget(
				new MockEmbeddingModelV4({
					doEmbed: async ({ values }) => {
						h.embedRequests++;
						return {
							embeddings: values.map(() => [0.1, 0.2]),
							usage: { tokens: 3 },
							warnings: [],
						};
					},
				}),
			),
		);
		const { embedding } = await embed({ model, value: query });
		return { embedding };
	}),
}));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	ensureCollection: vi.fn(async () => "project-contexts"),
	getCollectionLayout: vi.fn(async () => ({ supportsHybrid: false })),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { search: vi.fn(async () => []), query: vi.fn() },
}));

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import {
	runWithTurnDispatch,
	TURN_BUDGET_EXHAUSTED,
} from "../../turn-dispatch";
import { runFabricCatalogTool } from "../fabric-catalog-adapter";

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

beforeEach(() => {
	h.embedRequests = 0;
	h.reserve.mockReset().mockResolvedValue({
		outcome: "exhausted",
		snapshot: {
			contractVersion: 1,
			allowance: 100_000,
			finalizationReserve: 8_000,
			measured: 92_000,
			outstanding: 0,
			enforcement: "ENFORCED",
		},
		room: 0,
		needed: 10,
	});
});

function expectBudgetRefusal(outcome: unknown) {
	expect(outcome).toBeInstanceOf(ApplicationFailure);
	expect((outcome as ApplicationFailure).type).toBe(TURN_BUDGET_EXHAUSTED);
	expect((outcome as ApplicationFailure).nonRetryable).toBe(true);
}

describe("a token-allowance refusal inside a catalog tool", () => {
	it("leaves code_search_semantic as TurnBudgetExhausted, not a failed tool result", async () => {
		const outcome = await runWithTurnDispatch(SCOPE, () =>
			runFabricCatalogTool({
				toolName: "code_search_semantic",
				args: { query: "where is the launch flag defined" },
				userId: SCOPE.userId,
				organizationId: SCOPE.organizationId,
				projectId: "project-example-1",
			}),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);

		expectBudgetRefusal(outcome);
		// The refusal was the embedding's reservation: nothing was sent.
		expect(h.reserve).toHaveBeenCalledTimes(1);
		expect(h.reserve.mock.calls[0]?.[0]).toMatchObject({
			kind: "AUXILIARY",
		});
		expect(h.embedRequests).toBe(0);
	});
});

describe("the guard's backstop", () => {
	async function refusedRequest(): Promise<unknown> {
		const budget = getDispatchGuard()?.budget;
		return budget
			?.reserve({
				modality: "language",
				inputEstimate: 10,
				requestedOutputTokens: 100,
				minOutputTokens: 10,
				enforcesOutputCap: true,
			})
			.catch((error: unknown) => error);
	}

	it("fails work that turned the refusal into a value", async () => {
		const outcome = await runWithTurnDispatch(SCOPE, async () => {
			await refusedRequest();
			return { success: false, error: "the tool could not run" };
		}).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
		expectBudgetRefusal(outcome);
	});

	it("fails work that turned the refusal into an ordinary error", async () => {
		const outcome = await runWithTurnDispatch(SCOPE, async () => {
			await refusedRequest();
			throw new Error("tool failed");
		}).catch((error: unknown) => error);
		expectBudgetRefusal(outcome);
	});

	it("keeps a cancellation the work ends with: a stop wins over the allowance", async () => {
		const cancelled = new CancelledFailure("Activity cancelled");
		const outcome = await runWithTurnDispatch(SCOPE, async () => {
			await refusedRequest();
			throw cancelled;
		}).catch((error: unknown) => error);
		expect(outcome).toBe(cancelled);
	});

	it("leaves work with no refusal untouched", async () => {
		await expect(
			runWithTurnDispatch(SCOPE, async () => ({ success: true })),
		).resolves.toEqual({ success: true });
	});
});
