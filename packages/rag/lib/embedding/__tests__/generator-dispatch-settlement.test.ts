/**
 * Inside a dispatch guard (a stopped Advisor chat turn), `generateEmbeddings`
 * must not settle while a provider request it started is still running.
 *
 * The AI SDK splits a large `embedMany` into several provider requests and,
 * for a model that supports it, runs them under one `Promise.all`. When one
 * request is refused that `Promise.all` rejects at once, while a sibling the
 * guard aborted is still settling, so the stop used to leave this function
 * (and the caller's activity) with a request still in flight. Under a guard
 * the requests now run one at a time.
 *
 * Runs the real `embedMany` and the real factory middleware against a
 * provider that honours its abort signal but takes a moment to reject.
 */

import { wrapEmbeddingModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { MockEmbeddingModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	model: { current: undefined as unknown },
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: vi.fn(async () => ({
		model: hoisted.model.current,
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

import { generateEmbeddings } from "../generator";

class StopError extends Error {}

const TENANT = { userId: "user-1", organizationId: "org-1" };

/**
 * A guard shaped like a chat turn's: its first check passes, the turn is
 * stopped shortly after that request starts, and every later check refuses.
 * Once stopped, any error handed to `rethrowIfStopped` leaves as the stop.
 */
function stoppingGuard() {
	const controller = new AbortController();
	const stop = new StopError("turn stopped");
	let checks = 0;
	const guard: DispatchGuard = {
		key: "turn-1",
		assertDispatchable: async () => {
			checks += 1;
			if (controller.signal.aborted) {
				throw controller.signal.reason;
			}
			if (checks > 1) {
				controller.abort(stop);
				throw stop;
			}
			// The Stop is recorded while this first request is in flight.
			setTimeout(() => controller.abort(stop), 10);
		},
		abortSignal: () => controller.signal,
		rethrowIfStopped: (error) => {
			if (controller.signal.aborted) {
				throw controller.signal.reason;
			}
			if (error instanceof StopError) {
				throw error;
			}
		},
	};
	return { guard, stop };
}

let events: string[];
let started: number;
let settled: number;

beforeEach(() => {
	events = [];
	started = 0;
	settled = 0;
	hoisted.model.current = wrapEmbeddingModelWithDispatchGuard(
		new MockEmbeddingModelV4({
			maxEmbeddingsPerCall: 1,
			supportsParallelCalls: true,
			doEmbed: ({ abortSignal }) => {
				started += 1;
				return new Promise((_resolve, reject) => {
					// Honours the signal, but rejects only after a delay.
					const giveUp = () =>
						setTimeout(() => {
							settled += 1;
							events.push("provider settled");
							reject(new DOMException("aborted", "AbortError"));
						}, 30);
					if (abortSignal?.aborted) {
						giveUp();
					} else {
						abortSignal?.addEventListener("abort", giveUp);
					}
				});
			},
		}),
	);
});

describe("generateEmbeddings inside a dispatch guard", () => {
	it("settles only after every provider request it started has settled", async () => {
		const { guard, stop } = stoppingGuard();

		const error = await runWithDispatchGuard(guard, () =>
			generateEmbeddings(["a", "b", "c"], TENANT),
		).catch((caught: unknown) => {
			events.push("call settled");
			return caught;
		});

		expect(error).toBe(stop);
		expect(started).toBeGreaterThan(0);
		expect(settled).toBe(started);
		expect(events.at(-1)).toBe("call settled");
	});
});
