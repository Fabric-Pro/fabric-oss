/**
 * `retrieveProjectContexts` rethrew every failure as a new
 * `Error("Failed to retrieve project contexts: ...")` with no cause, so a
 * stop raised under the caller's dispatch guard (a stopped Advisor chat turn;
 * see @repo/utils/dispatch-guard) reached the project-RAG activity as an
 * ordinary failure and became "no context". A stop now leaves as it is, and
 * any other failure keeps its cause.
 */

import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
		},
	},
	getProjectRagSettings: vi.fn(),
	getRetrievableContextById: vi.fn(),
	getRetrievableConversationBundleById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateEmbedding: vi.fn() }));

vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));

vi.mock("../store", () => ({ searchSimilarProjectContexts: vi.fn() }));

vi.mock("../summary-injection", () => ({
	applyContextSummary: (list: unknown) => list,
}));

import { getProjectRagSettings } from "@repo/database";
import { generateEmbedding } from "../../embedding";
import { retrieveProjectContexts } from "../retrieval";

class StopError extends Error {}

const guard: DispatchGuard = {
	key: "turn-1",
	assertDispatchable: async () => undefined,
	abortSignal: () => undefined,
	rethrowIfStopped: (error) => {
		if (error instanceof StopError) {
			throw error;
		}
	},
};

const OPTIONS = {
	projectId: "project-1",
	query: "launch plan",
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(getProjectRagSettings).mockResolvedValue({
		topK: 5,
		similarityThreshold: 0.5,
		enableReranking: false,
	} as never);
});

describe("retrieveProjectContexts failures", () => {
	it("rethrows a stop as it is inside the dispatch guard", async () => {
		const stop = new StopError("turn stopped");
		vi.mocked(generateEmbedding).mockRejectedValue(stop);

		const error = await runWithDispatchGuard(guard, () =>
			retrieveProjectContexts(OPTIONS),
		).catch((caught: unknown) => caught);

		expect(error).toBe(stop);
	});

	it("wraps any other failure with its cause kept", async () => {
		const failure = new Error("embedding provider unavailable");
		vi.mocked(generateEmbedding).mockRejectedValue(failure);

		const error = await runWithDispatchGuard(guard, () =>
			retrieveProjectContexts(OPTIONS),
		).catch((caught: unknown) => caught);

		expect((error as Error).message).toBe(
			"Failed to retrieve project contexts: embedding provider unavailable",
		);
		expect((error as Error).cause).toBe(failure);
	});
});
