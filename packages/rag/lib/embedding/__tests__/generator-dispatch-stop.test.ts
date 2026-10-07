/**
 * A stop raised under the caller's dispatch guard (a stopped Advisor chat
 * turn; see @repo/utils/dispatch-guard) must leave `generateEmbedding` and
 * `generateEmbeddings` as it is. Both used to rethrow every failure as a new
 * `Error("Embedding generation failed: ...")` with no cause, which hid the
 * stop from every catch above them, so the turn's lookup degraded to an empty
 * result instead of ending. Any other failure is still wrapped, now with its
 * cause kept.
 */

import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock, embedManyMock } = vi.hoisted(() => ({
	embedMock: vi.fn(),
	embedManyMock: vi.fn(),
}));

vi.mock("ai", () => ({
	embed: embedMock,
	embedMany: embedManyMock,
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: vi.fn(async () => ({
		model: { id: "text-embedding-3-small" },
		metadata: {
			modelString: "openai/text-embedding-3-small",
			selectionSource: "test",
		},
		trackUsage: vi.fn(),
	})),
	logEmbeddingUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generateEmbedding, generateEmbeddings } from "../generator";

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

const TENANT = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("generateEmbedding", () => {
	it("rethrows a stop as it is inside the dispatch guard", async () => {
		const stop = new StopError("turn stopped");
		embedMock.mockRejectedValue(stop);

		const error = await runWithDispatchGuard(guard, () =>
			generateEmbedding("hello", TENANT),
		).catch((caught: unknown) => caught);

		expect(error).toBe(stop);
	});

	it("wraps any other failure with its cause kept", async () => {
		const failure = new Error("provider unavailable");
		embedMock.mockRejectedValue(failure);

		const error = await runWithDispatchGuard(guard, () =>
			generateEmbedding("hello", TENANT),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Embedding generation failed: provider unavailable",
		);
		expect((error as Error).cause).toBe(failure);
	});

	it("keeps the wrapped failure, with its cause, outside any guard", async () => {
		const stop = new StopError("turn stopped");
		embedMock.mockRejectedValue(stop);

		const error = await generateEmbedding("hello", TENANT).catch(
			(caught: unknown) => caught,
		);

		expect((error as Error).message).toBe(
			"Embedding generation failed: turn stopped",
		);
		expect((error as Error).cause).toBe(stop);
	});
});

describe("generateEmbeddings", () => {
	it("rethrows a stop as it is inside the dispatch guard", async () => {
		const stop = new StopError("turn stopped");
		embedManyMock.mockRejectedValue(stop);

		const error = await runWithDispatchGuard(guard, () =>
			generateEmbeddings(["a", "b"], TENANT),
		).catch((caught: unknown) => caught);

		expect(error).toBe(stop);
	});

	it("wraps any other failure with its cause kept", async () => {
		const failure = new Error("provider unavailable");
		embedManyMock.mockRejectedValue(failure);

		const error = await runWithDispatchGuard(guard, () =>
			generateEmbeddings(["a", "b"], TENANT),
		).catch((caught: unknown) => caught);

		expect((error as Error).message).toBe(
			"Batch embedding generation failed: provider unavailable",
		);
		expect((error as Error).cause).toBe(failure);
	});
});
