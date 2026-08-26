/**
 * summarizeLargeToolResult — rate-limit resilience + heartbeat (issue #2288).
 *
 * Production symptom: the summarization LLM returned 429, the AI SDK burned its
 * 3 built-in attempts in a couple of seconds, and the activity fell straight
 * back to blind truncation. Separately, the path-2 (own-activity) call NEVER
 * heartbeat, because the old `onProgress` callback could not survive Temporal
 * payload serialization — an active HeartbeatTimeout for summarizations > 60s.
 *
 * These tests lock the three behaviors that fix it: retry only on transient
 * provider limits, a shared wait budget across every chunk of one invocation,
 * and a background heartbeat ticker independent of any caller callback.
 *
 * `@repo/ai/limits` is deliberately NOT mocked — the classification of
 * RetryError-wrapped provider errors is half of what is under test.
 */

import { ApplicationFailure } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	generateTextMock: vi.fn(),
	heartbeatMock: vi.fn(),
	getAIModelWithMetadataMock: vi.fn(async () => ({
		model: { __mockModel: true },
	})),
}));

vi.mock("ai", () => ({
	generateText: stubs.generateTextMock,
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: stubs.getAIModelWithMetadataMock,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: stubs.heartbeatMock,
}));

import {
	type SummarizeToolResultDeps,
	type SummarizeToolResultInput,
	summarizeLargeToolResult,
} from "../summarize-tool-result";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ~30K tokens; mirrors CHUNK_LIMIT in the source. */
const CHUNK_LIMIT = 120_000;
const MAX_CHUNKS = 6;

function buildInput(
	overrides: Partial<SummarizeToolResultInput> = {},
): SummarizeToolResultInput {
	return {
		toolName: "get_meeting_transcript",
		toolResult: "a".repeat(1000),
		userQuery: "What were the action items?",
		maxOutputLength: 12_000,
		userId: "user-1",
		organizationId: "org-1",
		...overrides,
	};
}

/**
 * `random: () => 1` makes equal jitter deterministic at its ceiling, so the
 * backoff sequence is exactly the 10s / 30s exponential base.
 */
function makeDeps(overrides: Partial<SummarizeToolResultDeps> = {}) {
	const sleeps: number[] = [];
	const deps: SummarizeToolResultDeps = {
		sleep: vi.fn(async (ms: number) => {
			sleeps.push(ms);
		}),
		now: () => 1_000_000,
		random: () => 1,
		...overrides,
	};
	return { deps, sleeps };
}

/**
 * The exact shape production sees: the AI SDK wraps the real `APICallError`
 * (which carries the provider headers on `.responseHeaders`) inside a
 * `RetryError` after exhausting its own attempts.
 */
function retryWrapped429(responseHeaders?: Record<string, string>) {
	const apiErr = Object.assign(new Error("Too Many Requests"), {
		name: "AI_APICallError",
		statusCode: 429,
		...(responseHeaders ? { responseHeaders } : {}),
	});
	return Object.assign(new Error("Failed after 3 attempts."), {
		name: "AI_RetryError",
		reason: "maxRetriesExceeded",
		lastError: apiErr,
		errors: [apiErr],
	});
}

beforeEach(() => {
	// `mockReset`, not `clearAllMocks`: a test that gives up early leaves unused
	// `...Once` entries queued, and clearAllMocks does not drain that queue — the
	// leftovers would shift every call in the next test by one.
	stubs.generateTextMock.mockReset();
	stubs.heartbeatMock.mockReset();
	stubs.getAIModelWithMetadataMock.mockReset();

	stubs.getAIModelWithMetadataMock.mockResolvedValue({
		model: { __mockModel: true },
	});
	stubs.generateTextMock.mockResolvedValue({ text: "SUMMARY" });
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

describe("summarizeLargeToolResult — provider rate limits", () => {
	it("rides out two 429s and returns the summary", async () => {
		stubs.generateTextMock
			.mockRejectedValueOnce(retryWrapped429())
			.mockRejectedValueOnce(retryWrapped429())
			.mockResolvedValueOnce({ text: "SUMMARY" });

		const { deps, sleeps } = makeDeps();
		await expect(
			summarizeLargeToolResult(buildInput(), deps),
		).resolves.toBe("SUMMARY");

		expect(stubs.generateTextMock).toHaveBeenCalledTimes(3);
		// Equal jitter at its ceiling: base 10s then 30s.
		expect(sleeps).toEqual([10_000, 30_000]);
	});

	it("bounds the SDK's own retries with maxRetries: 1", async () => {
		await summarizeLargeToolResult(buildInput(), makeDeps().deps);
		expect(stubs.generateTextMock.mock.calls[0]?.[0]).toMatchObject({
			maxRetries: 1,
		});
	});

	it("rethrows a non-limit error immediately without sleeping", async () => {
		const boom = new Error("database is down");
		stubs.generateTextMock.mockRejectedValue(boom);

		const { deps, sleeps } = makeDeps();
		await expect(summarizeLargeToolResult(buildInput(), deps)).rejects.toBe(
			boom,
		);

		expect(stubs.generateTextMock).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it("rethrows a quota exhaustion immediately — waiting cannot clear billing", async () => {
		const quota = Object.assign(
			new Error("You exceeded your current quota"),
			{
				name: "AI_APICallError",
				statusCode: 429,
				code: "insufficient_quota",
			},
		);
		stubs.generateTextMock.mockRejectedValue(quota);

		const { deps, sleeps } = makeDeps();
		await expect(summarizeLargeToolResult(buildInput(), deps)).rejects.toBe(
			quota,
		);

		expect(stubs.generateTextMock).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it("honors Retry-After from the wrapped APICallError headers", async () => {
		stubs.generateTextMock
			.mockRejectedValueOnce(
				retryWrapped429({ "retry-after-ms": "1500" }),
			)
			.mockResolvedValueOnce({ text: "SUMMARY" });

		const { deps, sleeps } = makeDeps();
		await expect(
			summarizeLargeToolResult(buildInput(), deps),
		).resolves.toBe("SUMMARY");
		expect(sleeps).toEqual([1500]);
	});

	it("honors a whole-second Retry-After that fits the budget", async () => {
		stubs.generateTextMock
			.mockRejectedValueOnce(retryWrapped429({ "retry-after": "30" }))
			.mockResolvedValueOnce({ text: "SUMMARY" });

		const { deps, sleeps } = makeDeps();
		await expect(
			summarizeLargeToolResult(buildInput(), deps),
		).resolves.toBe("SUMMARY");
		expect(sleeps).toEqual([30_000]);
	});

	it("caps an absurd Retry-After at 60s and gives up rather than sleeping for an hour", async () => {
		stubs.generateTextMock.mockRejectedValueOnce(
			retryWrapped429({ "retry-after": "3600" }),
		);

		const { deps, sleeps } = makeDeps();
		await expect(
			summarizeLargeToolResult(buildInput(), deps),
		).rejects.toBeInstanceOf(ApplicationFailure);

		// The hour-long hint is capped to the 60s ceiling — and 60s still exceeds
		// the 45s per-invocation budget, so we truncate instead of stalling the
		// activity toward its startToClose timeout.
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("next wait 60000ms"),
		);
		expect(sleeps).toEqual([]);
	});

	it("shares one wait budget across chunked call sites and fails non-retryably when it runs out", async () => {
		// Two chunks. The first spends 10s + 30s of the 45s budget before
		// succeeding; the second's very first backoff (10s) no longer fits in the
		// 5s left, so the whole invocation gives up rather than retrying blind.
		stubs.generateTextMock
			.mockRejectedValueOnce(retryWrapped429())
			.mockRejectedValueOnce(retryWrapped429())
			.mockResolvedValueOnce({ text: "CHUNK-1" })
			.mockRejectedValueOnce(retryWrapped429());

		const { deps, sleeps } = makeDeps();
		const promise = summarizeLargeToolResult(
			buildInput({ toolResult: "b".repeat(CHUNK_LIMIT + 10_000) }),
			deps,
		);

		await expect(promise).rejects.toBeInstanceOf(ApplicationFailure);
		await promise.catch((err: ApplicationFailure) => {
			expect(err.nonRetryable).toBe(true);
			expect(err.message).toContain("provider_rate_limit");
			expect(err.message).toContain("wait budget exhausted");
		});

		expect(sleeps).toEqual([10_000, 30_000]);
	});
});

// ---------------------------------------------------------------------------
// Invocation deadline
// ---------------------------------------------------------------------------

describe("summarizeLargeToolResult — invocation deadline", () => {
	/** Deps whose injected clock advances only when a mocked call says it does. */
	function makeAdvancingDeps() {
		let clock = 1_000_000;
		const sleeps: number[] = [];
		const deps: SummarizeToolResultDeps = {
			sleep: vi.fn(async (ms: number) => {
				sleeps.push(ms);
				clock += ms;
			}),
			now: () => clock,
			random: () => 1,
		};
		const advance = (ms: number) => {
			clock += ms;
		};
		return { deps, sleeps, advance };
	}

	it("never schedules a sleep that would land past the deadline", async () => {
		// The failed call itself burns 205s of the 210s deadline, so the 10s
		// backoff that would normally follow cannot be afforded.
		const { deps, sleeps, advance } = makeAdvancingDeps();
		stubs.generateTextMock.mockImplementationOnce(async () => {
			advance(205_000);
			throw retryWrapped429();
		});

		const promise = summarizeLargeToolResult(buildInput(), deps);
		await expect(promise).rejects.toBeInstanceOf(ApplicationFailure);
		await promise.catch((err: ApplicationFailure) => {
			expect(err.nonRetryable).toBe(true);
			expect(err.message).toContain("invocation deadline reached");
		});

		// Budget alone would have allowed this wait — only the deadline stopped it.
		expect(sleeps).toEqual([]);
		expect(stubs.generateTextMock).toHaveBeenCalledTimes(1);
	});

	it("stops before starting another LLM call once the deadline has passed", async () => {
		// A slow but SUCCESSFUL first chunk eats the deadline. The retry logic
		// never sees it, so the entry check is what bounds the chunk loop.
		const { deps, advance } = makeAdvancingDeps();
		stubs.generateTextMock.mockImplementationOnce(async () => {
			advance(215_000);
			return { text: "CHUNK-1" };
		});

		const promise = summarizeLargeToolResult(
			buildInput({ toolResult: "b".repeat(CHUNK_LIMIT + 10_000) }),
			deps,
		);
		await expect(promise).rejects.toBeInstanceOf(ApplicationFailure);
		await promise.catch((err: ApplicationFailure) => {
			expect(err.type).toBe("SummarizeToolResultDeadlineExceeded");
			expect(err.nonRetryable).toBe(true);
		});

		// The second chunk's call was never issued.
		expect(stubs.generateTextMock).toHaveBeenCalledTimes(1);
	});

	it("passes an abort signal bounding each in-flight call to the remaining time", async () => {
		await summarizeLargeToolResult(buildInput(), makeAdvancingDeps().deps);
		const callArg = stubs.generateTextMock.mock.calls[0]?.[0] as {
			abortSignal?: AbortSignal;
		};
		expect(callArg.abortSignal).toBeInstanceOf(AbortSignal);
		expect(callArg.abortSignal?.aborted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Heartbeat ticker
// ---------------------------------------------------------------------------

describe("summarizeLargeToolResult — heartbeat ticker", () => {
	it("heartbeats every 15s while a single generateText call is slow", async () => {
		vi.useFakeTimers();

		let resolveGenerate: (value: { text: string }) => void = () => {};
		stubs.generateTextMock.mockImplementation(
			() =>
				new Promise<{ text: string }>((resolve) => {
					resolveGenerate = resolve;
				}),
		);

		const promise = summarizeLargeToolResult(buildInput(), makeDeps().deps);
		// Flush the awaited model resolution so the call is genuinely in flight.
		await vi.advanceTimersByTimeAsync(0);
		expect(stubs.heartbeatMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(46_000);
		expect(stubs.heartbeatMock.mock.calls.length).toBeGreaterThanOrEqual(3);
		// No details argument: on the in-process path this shares the parent
		// activity's context and details would clobber its own heartbeat payload.
		expect(stubs.heartbeatMock).toHaveBeenCalledWith();

		resolveGenerate({ text: "SUMMARY" });
		await expect(promise).resolves.toBe("SUMMARY");

		// Ticker is cleared once the invocation settles.
		const callsAtSettle = stubs.heartbeatMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(stubs.heartbeatMock.mock.calls.length).toBe(callsAtSettle);
	});

	it("survives a heartbeat that throws outside an activity context", async () => {
		vi.useFakeTimers();
		stubs.heartbeatMock.mockImplementation(() => {
			throw new Error("Activity context not found");
		});

		let resolveGenerate: (value: { text: string }) => void = () => {};
		stubs.generateTextMock.mockImplementation(
			() =>
				new Promise<{ text: string }>((resolve) => {
					resolveGenerate = resolve;
				}),
		);

		const promise = summarizeLargeToolResult(buildInput(), makeDeps().deps);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(31_000);
		expect(stubs.heartbeatMock).toHaveBeenCalled();

		resolveGenerate({ text: "SUMMARY" });
		await expect(promise).resolves.toBe("SUMMARY");
	});
});

// ---------------------------------------------------------------------------
// Chunk cap
// ---------------------------------------------------------------------------

describe("summarizeLargeToolResult — chunk cap", () => {
	it("truncates input beyond 6 chunks instead of queueing unbounded LLM calls", async () => {
		stubs.generateTextMock.mockResolvedValue({ text: "PART" });

		const oversized = "c".repeat(CHUNK_LIMIT * MAX_CHUNKS + 250_000);
		await summarizeLargeToolResult(
			buildInput({ toolResult: oversized }),
			makeDeps().deps,
		);

		// 6 chunks, and the short combined summary needs no final pass.
		expect(stubs.generateTextMock.mock.calls.length).toBeLessThanOrEqual(
			MAX_CHUNKS + 1,
		);
		expect(stubs.generateTextMock).toHaveBeenCalledTimes(MAX_CHUNKS);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("dropping 250000 chars"),
		);
	});
});
