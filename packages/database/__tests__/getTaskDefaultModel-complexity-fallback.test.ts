/**
 * Regression test for the complexity fallback in `getTaskDefaultModel`.
 *
 * Root cause this test guards against:
 *   `packages/database/prisma/ai-model-catalog.ts` seeds TASK_DEFAULTS
 *   asymmetrically — some task types only have MEDIUM entries, others
 *   have MEDIUM + COMPLEX. Specifically `TOOL_CALLING` only has MEDIUM
 *   (line ~2059 in the catalog). Meanwhile
 *   `mapReasoningModeToComplexity` (in
 *   `packages/temporal/src/activities/direct-chat/ai-execution.ts`)
 *   maps reasoningMode="pro" → complexity="COMPLEX".
 *
 *   When a Fabric Loom launcher prompt arrives with reasoningMode="pro"
 *   AND tools bound (always), the resolution chain is:
 *     `selectModelDynamic` → `getModelForTask` (no override + complex
 *     fallthrough) → `getTaskDefaultModel("TOOL_CALLING", "COMPLEX", ...)`.
 *   Without the fallback, that returned null, the activity threw before
 *   streamText, and users saw the generic
 *     `data: {"type":"error","message":"Workflow execution failed"}`
 *   SSE event from `executeDirectChatActivity`.
 *
 *   The fix in `getTaskDefaultModel` retries with `complexity="MEDIUM"`
 *   when the requested tier has no rows. MEDIUM is the only
 *   universally-seeded tier, so it's a safe default.
 *
 * Test strategy:
 *   Mock the prisma client so we can drive the two-call flow
 *   deterministically without needing a real database. The cache layer
 *   is also mocked to a pass-through so we exercise the actual query
 *   logic and not memoized state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the cache wrapper to pass-through so the fallback retry actually
// runs. Path is relative to the imported module's own location.
vi.mock("../prisma/queries/cache", () => ({
	aiTaskDefaultsCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
	aiModelCatalogCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
}));

// Mock the ai-credits module — it reads env vars at import time which
// blow up in the test environment.
vi.mock("../prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));

// The query module reaches for `db` from `../client`. We give it a stub
// that the tests can wire per-case via the exported `findMany` mock.
const findManyMock = vi.fn();
vi.mock("../prisma/client", () => ({
	db: {
		aiModelProviderMapping: { findMany: vi.fn() },
		aiTaskModelDefault: { findMany: findManyMock },
	},
}));

// Import AFTER mocks so the query sees them.
const { getTaskDefaultModel } = await import("../prisma/queries/ai-models");

const mediumModel = {
	id: "model-medium",
	canonicalName: "gpt-4o",
	displayName: "GPT-4o",
	providerMappings: [
		{ provider: "OPENAI_DIRECT", providerModelId: "gpt-4o" },
	],
};

describe("getTaskDefaultModel — complexity fallback (PR 1102 regression guard)", () => {
	beforeEach(() => {
		findManyMock.mockReset();
	});

	it("returns MEDIUM when COMPLEX is requested but only MEDIUM is seeded", async () => {
		// First call: TOOL_CALLING + COMPLEX → no rows.
		findManyMock.mockResolvedValueOnce([]);
		// Second call (fallback): TOOL_CALLING + MEDIUM → returns gpt-4o.
		findManyMock.mockResolvedValueOnce([{ model: mediumModel }]);

		const model = await getTaskDefaultModel(
			"TOOL_CALLING" as never,
			"COMPLEX" as never,
			"OPENAI_DIRECT" as never,
		);

		expect(model).toEqual(mediumModel);
		expect(findManyMock).toHaveBeenCalledTimes(2);
		// First call args: COMPLEX
		expect(findManyMock.mock.calls[0][0].where.complexity).toBe("COMPLEX");
		// Second (fallback) call args: MEDIUM, same taskType + provider
		expect(findManyMock.mock.calls[1][0].where.complexity).toBe("MEDIUM");
		expect(findManyMock.mock.calls[1][0].where.taskType).toBe(
			"TOOL_CALLING",
		);
		expect(findManyMock.mock.calls[1][0].where.provider).toBe(
			"OPENAI_DIRECT",
		);
	});

	it("does NOT retry when COMPLEX returns a row (happy path, no fallback needed)", async () => {
		const complexModel = { ...mediumModel, id: "model-complex" };
		findManyMock.mockResolvedValueOnce([{ model: complexModel }]);

		const model = await getTaskDefaultModel(
			"TOOL_CALLING" as never,
			"COMPLEX" as never,
			"OPENAI_DIRECT" as never,
		);

		expect(model).toEqual(complexModel);
		// Single query — no fallback was needed.
		expect(findManyMock).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry when MEDIUM itself is requested (no recursion / no looping)", async () => {
		// Requesting MEDIUM directly; if it has no rows, we return null
		// instead of looping back to MEDIUM. The fallback only fires for
		// non-MEDIUM tiers — that's the contract that keeps the helper
		// from infinite-looping if MEDIUM is also unseeded.
		findManyMock.mockResolvedValueOnce([]);

		const model = await getTaskDefaultModel(
			"TOOL_CALLING" as never,
			"MEDIUM" as never,
			"OPENAI_DIRECT" as never,
		);

		expect(model).toBeNull();
		expect(findManyMock).toHaveBeenCalledTimes(1);
	});

	it("returns null when BOTH the requested complexity and MEDIUM have no rows", async () => {
		// First: SIMPLE has no rows. Fallback to MEDIUM also has no rows
		// → return null. This is the genuine "no model configured" case
		// that callers must surface to the user.
		findManyMock.mockResolvedValueOnce([]); // SIMPLE
		findManyMock.mockResolvedValueOnce([]); // MEDIUM fallback

		const model = await getTaskDefaultModel(
			"EVAL" as never,
			"SIMPLE" as never,
			"GROQ" as never,
		);

		expect(model).toBeNull();
		expect(findManyMock).toHaveBeenCalledTimes(2);
	});

	it("preserves the optional provider filter through both query attempts", async () => {
		// Edge case: when `provider` is omitted, the where clause should
		// not include it in EITHER call. Tests that the fallback retry
		// doesn't accidentally over-specify or under-specify the filter.
		findManyMock.mockResolvedValueOnce([]); // COMPLEX
		findManyMock.mockResolvedValueOnce([{ model: mediumModel }]); // MEDIUM

		await getTaskDefaultModel(
			"TOOL_CALLING" as never,
			"COMPLEX" as never,
			// No provider arg
		);

		expect(findManyMock).toHaveBeenCalledTimes(2);
		expect(findManyMock.mock.calls[0][0].where.provider).toBeUndefined();
		expect(findManyMock.mock.calls[1][0].where.provider).toBeUndefined();
	});
});
