/**
 * `fabric instructions push` waiting for a repository proposal's pull
 * request (Fizzy #2563 spec §12; plan Task 17 Step 2).
 *
 * The wait polls every 2 s against an ABSOLUTE 60 s deadline: not 60 s per
 * request, and not "roughly a minute of polls". A status request that hangs
 * is cancelled at the deadline wherever it is, in the fetch, the body read or
 * the SDK's own retry backoff, and no request or sleep starts after it. The
 * clock is Vitest's: `setTimeout` and `Date` are faked, so every assertion
 * about time is exact.
 */
import { createFabric, type FabricClient } from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PULL_REQUEST_POLL_MS,
	PULL_REQUEST_WAIT_MS,
	splitMessage,
	waitForPullRequest,
} from "../src/lib/instructions/pull-request-wait.js";

function block(state: string, overrides: Record<string, unknown> = {}) {
	return {
		operationId: "op-1",
		state,
		url: null,
		externalId: null,
		failure: null,
		lastCheckedAt: null,
		attempt: 1,
		observation: null,
		mergeSync: null,
		...overrides,
	};
}

/** A client whose status read answers from `answer`, recording each call's time and signal. */
function fakeClient(
	answer: (call: number, signal: AbortSignal) => Promise<unknown>,
) {
	const calls: Array<{ at: number; signal: AbortSignal }> = [];
	const client = {
		instructions: {
			getProposalPullRequest: (
				_projectId: string,
				_snapshotId: string,
				options: { signal: AbortSignal },
			) => {
				calls.push({ at: Date.now(), signal: options.signal });
				return answer(calls.length, options.signal);
			},
		},
	} as unknown as FabricClient;
	return { client, calls };
}

/** Settles `promise` by advancing the fake clock, and reports when it settled. */
async function settle<T>(
	promise: Promise<T>,
): Promise<{ value: T; at: number }> {
	let done = false;
	let value: T | undefined;
	let failure: unknown;
	let at = 0;
	promise.then(
		(v) => {
			done = true;
			value = v;
			at = Date.now();
		},
		(e) => {
			done = true;
			failure = e;
			at = Date.now();
		},
	);
	for (let i = 0; i < 1_000 && !done; i++) {
		await vi.advanceTimersByTimeAsync(100);
	}
	if (!done) {
		throw new Error("never settled");
	}
	if (failure !== undefined) {
		throw failure;
	}
	return { value: value as T, at };
}

let start = 0;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	start = Date.now();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("waitForPullRequest", () => {
	it("polls every 2 s until the pull request is open", async () => {
		const { client, calls } = fakeClient(async (call) =>
			block(call < 3 ? "QUEUED" : "OPEN", {
				url: call < 3 ? null : "https://example.com/pull/7",
			}),
		);

		const { value } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({
			kind: "settled",
			pullRequest: block("OPEN", { url: "https://example.com/pull/7" }),
		});
		expect(calls.map((c) => c.at - start)).toEqual([
			0,
			PULL_REQUEST_POLL_MS,
			2 * PULL_REQUEST_POLL_MS,
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["BLOCKED", "CANCELED", "MERGED", "CLOSED", "CLOSE_REQUESTED"])(
		"stops at %s",
		async (state) => {
			const { client, calls } = fakeClient(async () => block(state));

			const { value } = await settle(
				waitForPullRequest(client, "proj-1", "snap-8"),
			);

			expect(value).toEqual({
				kind: "settled",
				pullRequest: block(state),
			});
			expect(calls).toHaveLength(1);
		},
	);

	it("answers none for a proposal with no pull request", async () => {
		const { client } = fakeClient(async () => null);

		expect(
			(await settle(waitForPullRequest(client, "proj-1", "snap-8")))
				.value,
		).toEqual({ kind: "none" });
	});

	it("starts no request and no sleep after the deadline, and holds the deadline absolutely", async () => {
		const { client, calls } = fakeClient(async () => block("QUEUED"));

		const { value, at } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({
			kind: "timed_out",
			pullRequest: block("QUEUED"),
		});
		// Every request started inside the window, 2 s apart, and the wait
		// ended rather than sleeping past the deadline.
		const offsets = calls.map((c) => c.at - start);
		expect(offsets[0]).toBe(0);
		expect(offsets.at(-1)).toBeLessThan(PULL_REQUEST_WAIT_MS);
		expect(offsets.at(-1)! + PULL_REQUEST_POLL_MS).toBeGreaterThanOrEqual(
			PULL_REQUEST_WAIT_MS,
		);
		expect(at - start).toBeLessThanOrEqual(PULL_REQUEST_WAIT_MS);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not wait past the deadline on a hanging status request, and aborts it", async () => {
		const { client, calls } = fakeClient(
			(_call, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(signal.reason),
						{
							once: true,
						},
					);
				}),
		);

		const { value, at } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({ kind: "timed_out", pullRequest: null });
		expect(at - start).toBe(PULL_REQUEST_WAIT_MS);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal.aborted).toBe(true);
	});

	it("reports the last state it saw when the deadline cuts a later request short", async () => {
		const { client } = fakeClient((call, signal) =>
			call === 1
				? Promise.resolve(block("OPENING"))
				: new Promise((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => reject(signal.reason),
							{
								once: true,
							},
						);
					}),
		);

		const { value, at } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({
			kind: "timed_out",
			pullRequest: block("OPENING"),
		});
		expect(at - start).toBe(PULL_REQUEST_WAIT_MS);
	});

	it("rethrows a failure that is not the deadline", async () => {
		const { client } = fakeClient(async () => {
			throw Object.assign(new Error("Proposal not found"), {
				status: 404,
			});
		});

		await expect(
			settle(waitForPullRequest(client, "proj-1", "snap-8")),
		).rejects.toThrow("Proposal not found");
	});
});

/**
 * The same deadline through the REAL SDK client over a stub `fetch`: the
 * expiry reaches the request wherever it is waiting.
 */
describe("the deadline reaches into the SDK request", () => {
	function hangUntilAborted(signal: AbortSignal | null | undefined) {
		return new Promise<never>((_resolve, reject) => {
			signal?.addEventListener(
				"abort",
				() => {
					const error = new Error("The operation was aborted");
					error.name = "AbortError";
					reject(error);
				},
				{ once: true },
			);
		});
	}

	function sdk(fetchImpl: typeof fetch, retry = {}) {
		return createFabric({
			apiKey: "fab_test_key",
			baseUrl: "https://test.fabric",
			fetch: fetchImpl,
			// Longer than the wait, so only the deadline can end a request.
			timeoutMs: 120_000,
			retry,
		});
	}

	it("expires during the fetch", async () => {
		let attempts = 0;
		const client = sdk(async (_input, init) => {
			attempts++;
			return hangUntilAborted(init?.signal);
		});

		const { value, at } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({ kind: "timed_out", pullRequest: null });
		expect(at - start).toBe(PULL_REQUEST_WAIT_MS);
		expect(attempts).toBe(1);
	});

	it("expires during the body read", async () => {
		const client = sdk(
			async (_input, init) =>
				({
					ok: true,
					status: 200,
					json: () => hangUntilAborted(init?.signal),
				}) as unknown as Response,
		);

		const { value, at } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({ kind: "timed_out", pullRequest: null });
		expect(at - start).toBe(PULL_REQUEST_WAIT_MS);
	});

	it("expires during the SDK's retry backoff, starting no attempt after it", async () => {
		const attemptsAt: number[] = [];
		const client = sdk(
			async () => {
				attemptsAt.push(Date.now() - start);
				throw new TypeError("fetch failed");
			},
			{ maxRetries: 2, initialDelayMs: 40_000, maxDelayMs: 40_000 },
		);

		const { value, at } = await settle(
			waitForPullRequest(client, "proj-1", "snap-8"),
		);

		expect(value).toEqual({ kind: "timed_out", pullRequest: null });
		expect(at - start).toBe(PULL_REQUEST_WAIT_MS);
		// At 0 and after the first 40 s backoff; the second backoff would end
		// at 80 s and is cut at the deadline.
		expect(attemptsAt).toEqual([0, 40_000]);
	});
});

describe("splitMessage", () => {
	it("takes the first line as the title and the rest as the body", () => {
		expect(splitMessage("Tighten the lint rule\n\nWhy.\nMore.")).toEqual({
			title: "Tighten the lint rule",
			body: "Why.\nMore.",
		});
	});

	it("splits a CRLF message exactly like an LF one", () => {
		expect(
			splitMessage("Tighten the lint rule\r\n\r\nWhy.\r\nMore."),
		).toEqual(splitMessage("Tighten the lint rule\n\nWhy.\nMore."));
		expect(splitMessage("Title\rBody")).toEqual({
			title: "Title",
			body: "Body",
		});
	});

	it("sends a one-line message as a title alone", () => {
		expect(splitMessage("Tighten the lint rule")).toEqual({
			title: "Tighten the lint rule",
		});
		expect(splitMessage("Tighten the lint rule\r\n")).toEqual({
			title: "Tighten the lint rule",
		});
	});
});
