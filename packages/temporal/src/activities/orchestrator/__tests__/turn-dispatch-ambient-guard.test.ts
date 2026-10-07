/**
 * `runWithTurnDispatch`: a chat turn's two gates installed as the ambient
 * dispatch guard that every `@repo/ai` factory model consults.
 *
 * Pins:
 *  - inside the guard, a factory model checks the turn record before each
 *    physical request with no per-call-site wrapping, and a Stop (the
 *    activity's cancellation) aborts the request in flight;
 *  - the explicit `guardTurnModel` wrapper from the first turn-cancellation
 *    change keeps its behaviour but does not read the turn record a second
 *    time when the factory's middleware already does for the same turn;
 *  - without a scope nothing is installed;
 *  - a refused request aborts the requests already in flight beside it under
 *    the same guard (an `embedMany` split into parallel requests, a model
 *    behind the explicit wrapper), and their failures are reported as that
 *    stop, not as ordinary errors.
 */

import {
	wrapEmbeddingModelWithDispatchGuard,
	wrapModelWithDispatchGuard,
} from "@repo/ai/lib/dispatch-guard-middleware";
import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { APICallError, embedMany, generateText } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkDispatchable } = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: checkDispatchable,
}));

import {
	guardTurnModel,
	isTurnNotDispatchable,
	rethrowIfTurnStopped,
	runWithTurnDispatch,
	settleAll,
	startTurnHeartbeat,
	turnScopeKey,
} from "../turn-dispatch";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const GENERATE_RESULT = {
	content: [{ type: "text" as const, text: "ok" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	},
	warnings: [],
};

function providerModel() {
	return new MockLanguageModelV4({ doGenerate: async () => GENERATE_RESULT });
}

beforeEach(() => {
	checkDispatchable.mockReset();
	checkDispatchable.mockResolvedValue({ ok: true });
});

describe("runWithTurnDispatch", () => {
	it("installs the turn's guard for the body only", () => {
		const key = runWithTurnDispatch(
			TURN_SCOPE,
			() => getDispatchGuard()?.key,
		);
		expect(key).toBe(turnScopeKey(TURN_SCOPE));
		expect(getDispatchGuard()).toBeUndefined();
	});

	it("installs nothing without a scope", () => {
		expect(
			runWithTurnDispatch(undefined, () => getDispatchGuard()),
		).toBeUndefined();
	});

	it("makes a factory model check the turn record before each physical request", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				if (calls === 1) {
					throw new APICallError({
						message: "Service Unavailable",
						url: "https://provider.example.com/v1",
						requestBodyValues: {},
						statusCode: 503,
						isRetryable: true,
					});
				}
				return GENERATE_RESULT;
			},
		});
		const model = wrapModelWithDispatchGuard(provider);

		await runWithTurnDispatch(TURN_SCOPE, () =>
			generateText({ model, prompt: "Hi", maxRetries: 1 }),
		);

		expect(checkDispatchable).toHaveBeenCalledTimes(2);
		expect(checkDispatchable).toHaveBeenCalledWith(TURN_SCOPE);
	});

	it("refuses a factory model's request once the turn is stopped, before the provider", async () => {
		checkDispatchable.mockResolvedValue({ ok: false, reason: "cancelled" });
		const provider = providerModel();
		const model = wrapModelWithDispatchGuard(provider);

		const error = await runWithTurnDispatch(TURN_SCOPE, () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		).catch((caught: unknown) => caught);

		expect(isTurnNotDispatchable(error)).toBe(true);
		expect(provider.doGenerateCalls).toHaveLength(0);
	});

	it("aborts a factory model's request in flight when the activity is cancelled", async () => {
		let sentSignal: AbortSignal | undefined;
		const provider = new MockLanguageModelV4({
			doGenerate: (options) => {
				sentSignal = options.abortSignal;
				return new Promise((_resolve, reject) => {
					options.abortSignal?.addEventListener("abort", () =>
						reject(options.abortSignal?.reason),
					);
				});
			},
		});
		const model = wrapModelWithDispatchGuard(provider);
		const env = new MockActivityEnvironment();

		const running = env.run(() =>
			runWithTurnDispatch(TURN_SCOPE, () =>
				generateText({ model, prompt: "Hi", maxRetries: 0 }),
			),
		);
		await vi.waitFor(() => expect(sentSignal).toBeDefined());
		env.cancel();

		const error = await running.catch((caught: unknown) => caught);
		expect(sentSignal?.aborted).toBe(true);
		expect(error).toBeInstanceOf(CancelledFailure);
	});
});

describe("guardTurnModel inside the turn's guard", () => {
	it("reads the turn record once per request for a factory model", async () => {
		const model = wrapModelWithDispatchGuard(providerModel());

		await runWithTurnDispatch(TURN_SCOPE, () =>
			generateText({
				model: guardTurnModel(model, TURN_SCOPE).model,
				prompt: "Hi",
			}),
		);

		expect(checkDispatchable).toHaveBeenCalledTimes(1);
	});

	it("still refuses a stopped turn's request for a factory model", async () => {
		checkDispatchable.mockResolvedValue({ ok: false, reason: "cancelled" });
		const provider = providerModel();
		const model = wrapModelWithDispatchGuard(provider);

		const error = await runWithTurnDispatch(TURN_SCOPE, () =>
			generateText({
				model: guardTurnModel(model, TURN_SCOPE).model,
				prompt: "Hi",
				maxRetries: 0,
			}),
		).catch((caught: unknown) => caught);

		expect(isTurnNotDispatchable(error)).toBe(true);
		expect(checkDispatchable).toHaveBeenCalledTimes(1);
		expect(provider.doGenerateCalls).toHaveLength(0);
	});

	it("checks itself for a model built outside the factory", async () => {
		await runWithTurnDispatch(TURN_SCOPE, () =>
			generateText({
				model: guardTurnModel(providerModel(), TURN_SCOPE).model,
				prompt: "Hi",
			}),
		);

		expect(checkDispatchable).toHaveBeenCalledTimes(1);
	});

	it("checks itself outside any guard", async () => {
		const model = wrapModelWithDispatchGuard(providerModel());

		await generateText({
			model: guardTurnModel(model, TURN_SCOPE).model,
			prompt: "Hi",
		});

		expect(checkDispatchable).toHaveBeenCalledTimes(1);
	});

	it("checks its own turn as well when the active guard is another turn's", async () => {
		const otherTurn = { ...TURN_SCOPE, turnId: "turn-example-2" };
		const model = wrapModelWithDispatchGuard(providerModel());

		await runWithTurnDispatch(otherTurn, () =>
			generateText({
				model: guardTurnModel(model, TURN_SCOPE).model,
				prompt: "Hi",
			}),
		);

		expect(checkDispatchable).toHaveBeenCalledTimes(2);
		expect(checkDispatchable).toHaveBeenCalledWith(TURN_SCOPE);
		expect(checkDispatchable).toHaveBeenCalledWith(otherTurn);
	});
});

/** A request that stays in flight until its abort signal fires. */
function pendingUntilAborted(signal: AbortSignal | undefined) {
	return new Promise<never>((_resolve, reject) => {
		// What fetch does: reject with an error of its own, not the reason.
		const abort = () =>
			reject(
				new DOMException("This operation was aborted", "AbortError"),
			);
		if (signal?.aborted) {
			abort();
		} else {
			signal?.addEventListener("abort", abort);
		}
	});
}

describe("a refused request aborts its siblings under the same guard", () => {
	it("aborts the other parallel embedMany request and reports the stop", async () => {
		checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
		const sent: AbortSignal[] = [];
		const provider = new MockEmbeddingModelV4({
			maxEmbeddingsPerCall: 1,
			supportsParallelCalls: true,
			doEmbed: async ({ abortSignal }) => {
				if (abortSignal) {
					sent.push(abortSignal);
				}
				return pendingUntilAborted(abortSignal);
			},
		});
		const model = wrapEmbeddingModelWithDispatchGuard(provider);

		const error = await runWithTurnDispatch(TURN_SCOPE, () =>
			embedMany({ model, values: ["a", "b"], maxRetries: 0 }),
		).catch((caught: unknown) => caught);

		expect(isTurnNotDispatchable(error)).toBe(true);
		// Only the request whose check passed reached the provider, and the
		// sibling's refusal aborted it.
		expect(sent).toHaveLength(1);
		expect(sent[0]?.aborted).toBe(true);
		expect(isTurnNotDispatchable(sent[0]?.reason)).toBe(true);
	});

	it("aborts a request behind the explicit wrapper, and its failure reads as the stop", async () => {
		checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
		let inFlight: AbortSignal | undefined;
		const outsideFactory = new MockLanguageModelV4({
			doGenerate: async ({ abortSignal }) => {
				inFlight = abortSignal;
				return pendingUntilAborted(abortSignal);
			},
		});
		const refused = wrapModelWithDispatchGuard(providerModel());

		const outcome = await runWithTurnDispatch(TURN_SCOPE, () => {
			const call = (model: Parameters<typeof generateText>[0]["model"]) =>
				generateText({ model, prompt: "Hi", maxRetries: 0 }).catch(
					(error: unknown) => {
						rethrowIfTurnStopped(error);
						return "fallback";
					},
				);
			return settleAll([
				call(guardTurnModel(outsideFactory, TURN_SCOPE).model),
				// Starts once the first request is in flight.
				vi
					.waitFor(() => expect(inFlight).toBeDefined())
					.then(() => call(refused)),
			]);
		}).catch((caught: unknown) => caught);

		expect(inFlight?.aborted).toBe(true);
		// The aborted request failed with an AbortError of its own; the catch
		// still recognised it as the stop and did not fall back.
		expect(isTurnNotDispatchable(outcome)).toBe(true);
	});

	it("refuses every later request under the guard without reading the turn record", async () => {
		checkDispatchable.mockResolvedValue({ ok: false, reason: "cancelled" });
		const model = wrapModelWithDispatchGuard(providerModel());

		await runWithTurnDispatch(TURN_SCOPE, async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const error = await generateText({
					model,
					prompt: "Hi",
					maxRetries: 0,
				}).catch((caught: unknown) => caught);
				expect(isTurnNotDispatchable(error)).toBe(true);
			}
		});

		expect(checkDispatchable).toHaveBeenCalledTimes(1);
	});
});

describe("settleAll", () => {
	it("inside a turn's guard, waits for every sibling before rejecting, and prefers a stop", async () => {
		const order: string[] = [];
		const slow = new Promise<string>((resolve) =>
			setTimeout(() => {
				order.push("slow settled");
				resolve("slow");
			}, 30),
		);
		checkDispatchable.mockResolvedValue({ ok: false, reason: "cancelled" });
		const stop = await runWithTurnDispatch(TURN_SCOPE, async () =>
			getDispatchGuard()?.assertDispatchable(),
		).catch((caught: unknown) => caught);

		const error = await runWithTurnDispatch(TURN_SCOPE, () =>
			settleAll([
				Promise.reject(new Error("provider unavailable")),
				slow,
				Promise.reject(stop),
			]),
		).catch((caught: unknown) => {
			order.push("rejected");
			return caught;
		});

		expect(order).toEqual(["slow settled", "rejected"]);
		expect(error).toBe(stop);
	});

	it("is Promise.all with no guard: the earliest rejection, without waiting for a pending sibling", async () => {
		let releaseSibling: () => void = () => undefined;
		const pendingSibling = new Promise<string>((resolve) => {
			releaseSibling = () => resolve("late");
		});
		const earliest = new Error("second input, rejects first");
		const later = new Promise<string>((_resolve, reject) =>
			setTimeout(
				() => reject(new Error("first input, rejects later")),
				20,
			),
		);
		later.catch(() => undefined);

		const error = await settleAll([
			later,
			Promise.reject(earliest),
			pendingSibling,
		]).catch((caught: unknown) => caught);

		// Reported while the sibling is still pending, and by time of
		// rejection rather than input order.
		expect(error).toBe(earliest);
		releaseSibling();
	});

	it("resolves like Promise.all", async () => {
		await expect(
			settleAll([Promise.resolve(1), Promise.resolve(2)]),
		).resolves.toEqual([1, 2]);
	});
});

describe("startTurnHeartbeat", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Runs `body` in an activity context, counting its heartbeats. */
	async function inActivity(body: (beats: () => number) => Promise<void>) {
		const env = new MockActivityEnvironment();
		let beats = 0;
		env.on("heartbeat", () => {
			beats += 1;
		});
		await env.run(() => body(() => beats));
	}

	it("heartbeats at once and then every 5 seconds for a turn, until stopped", async () => {
		vi.useFakeTimers();
		await inActivity(async (beats) => {
			const stop = startTurnHeartbeat(TURN_SCOPE);
			expect(beats()).toBe(1);
			await vi.advanceTimersByTimeAsync(4_999);
			expect(beats()).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(beats()).toBe(2);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(beats()).toBe(4);
			stop();
			await vi.advanceTimersByTimeAsync(20_000);
			expect(beats()).toBe(4);
		});
	});

	it("does nothing without a turn", async () => {
		vi.useFakeTimers();
		await inActivity(async (beats) => {
			const stop = startTurnHeartbeat(undefined);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(beats()).toBe(0);
			stop();
		});
	});
});
