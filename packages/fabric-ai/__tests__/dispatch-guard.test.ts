/**
 * Advisor Stop reaching the Fabric AI requests.
 *
 * `@repo/fabric-ai` sends its requests itself (raw `fetch`, and a provider
 * SDK transcription model built outside the `@repo/ai` factory), so the
 * factory's dispatch-guard middleware never sees them. Inside a dispatch guard
 * (an Advisor chat turn) every physical request must:
 *   - check the guard first, each retry included, and not be sent once the
 *     guard is stopped;
 *   - carry the guard's abort signal, so a Stop aborts it (and the reading of
 *     its body) in flight;
 * and every catch that turns an error into a fallback request, a default or a
 * `{ success: false }` result must rethrow the stop instead.
 *
 * With no guard active, behaviour is unchanged: failures fall back as before
 * and the package's own timeout still reports a timeout.
 *
 * `fetch` is mocked at the global boundary (or served by a real local HTTP
 * server for the streaming case), never inside the code under test.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { APICallError } from "ai";
import { MockLanguageModelV4, MockTranscriptionModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	transcriptionModel: { current: undefined as unknown },
}));

vi.mock("@repo/database", () => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: hoisted.getAIModelWithMetadata,
	getSystemRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "example-provider-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
		enabledProviders: [],
	}),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_operation: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
	createOpenAI: () => ({
		transcription: () => hoisted.transcriptionModel.current,
	}),
}));

import { createFabricClient } from "../client";
import { executeFabricPattern } from "../executor";
import { executePatternFull } from "../full-executor";
import { executePatternHybrid } from "../hybrid-executor";
import { createJinaClient } from "../jina-client";
import { transcribeAudio } from "../transcription";

const BASE_URL = "http://fabric.example.com";
const USER_CONTEXT = { userId: "user-example-1", organizationId: "org-1" };

class TestStop extends Error {
	override name = "TestStop";
}

/**
 * A guard with the same contract as the Advisor turn guard: a stop
 * controller whose signal every request carries, a check that refuses once
 * stopped, and a `rethrowIfStopped` that treats every failure after the stop
 * as the stop.
 */
function createGuard() {
	const stopController = new AbortController();
	const stopError = new TestStop("turn stopped");
	const assertDispatchable = vi.fn(async () => {
		if (stopController.signal.aborted) {
			throw stopController.signal.reason;
		}
	});
	const guard: DispatchGuard = {
		key: "turn-example-1",
		assertDispatchable,
		abortSignal: () => stopController.signal,
		rethrowIfStopped: (error) => {
			if (stopController.signal.aborted) {
				throw stopController.signal.reason;
			}
			if (error instanceof TestStop) {
				throw error;
			}
		},
	};
	return {
		guard,
		stopError,
		assertDispatchable,
		stop: () => stopController.abort(stopError),
	};
}

/** A fetch that never answers on its own and rejects when its signal aborts. */
function hangingFetch() {
	return vi.fn(
		(_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					return;
				}
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	);
}

/** Resolves once `fetchMock` has been called `count` times. */
async function waitForCalls(fetchMock: ReturnType<typeof vi.fn>, count = 1) {
	await vi.waitFor(() => {
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(count);
	});
}

function urlOf(call: unknown[]): string {
	return String(call[0]);
}

function languageModel() {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "analysis" }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: {
				inputTokens: {
					total: 1,
					noCache: 1,
					cacheRead: 0,
					cacheWrite: 0,
				},
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		}),
	});
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	hoisted.getAIModelWithMetadata.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("a stopped guard: no request is sent", () => {
	const client = () => createFabricClient({ baseUrl: BASE_URL });
	const requests: Array<[string, () => Promise<unknown>]> = [
		["scrapeUrl (timed client request)", () => client().scrapeUrl("u")],
		["searchWebDelegated", () => client().searchWebDelegated("q", "t")],
		["scrapeUrlDelegated", () => client().scrapeUrlDelegated("u", "t")],
		[
			"executePattern",
			() => client().executePattern({ input: "i", pattern: "summarize" }),
		],
		[
			"executePatternStream",
			() =>
				client()
					.executePatternStream({ input: "i", pattern: "summarize" })
					.next(),
		],
		["getYouTubeMetadata", () => client().getYouTubeMetadata("u", "t")],
		["getYouTubeComments", () => client().getYouTubeComments("u", "t")],
		["getYouTubePlaylist", () => client().getYouTubePlaylist("u", "t")],
		[
			"Jina search",
			() => createJinaClient({ apiKey: "example" }).search("q"),
		],
		[
			"Jina scrape",
			() => createJinaClient({ apiKey: "example" }).scrape("u"),
		],
	];

	it.each(requests)("%s", async (_name, request) => {
		const { guard, stop, stopError } = createGuard();
		stop();

		const error = await runWithDispatchGuard(guard, request).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBe(stopError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("checks the guard before EACH transcription attempt, so a retry after the stop is not sent", async () => {
		const { guard, stop, stopError, assertDispatchable } = createGuard();
		const doGenerate = vi.fn(async () => {
			// The first attempt fails retryably, and the turn is stopped
			// before the AI SDK's retry.
			stop();
			throw new APICallError({
				message: "Service Unavailable",
				url: "https://provider.example.com/v1/audio",
				requestBodyValues: {},
				statusCode: 503,
				responseHeaders: { "retry-after-ms": "1" },
				isRetryable: true,
			});
		});
		hoisted.transcriptionModel.current = new MockTranscriptionModelV4({
			doGenerate,
		});

		const error = await runWithDispatchGuard(guard, () =>
			transcribeAudio(Buffer.from("audio"), "meeting.mp3", {
				mode: "hybrid",
				userContext: USER_CONTEXT,
			}),
		).catch((caught: unknown) => caught);

		expect(error).toBe(stopError);
		expect(doGenerate).toHaveBeenCalledTimes(1);
		expect(assertDispatchable).toHaveBeenCalledTimes(2);
	});
});

describe("a request in flight carries the guard's signal and its abort leaves as the stop", () => {
	it("Jina search: rethrown, not a { success: false } result", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			createJinaClient({ apiKey: "example" }).search("q"),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock);
		const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
		expect(signal?.aborted).toBe(false);
		stop();

		expect(await running).toBe(stopError);
		expect(signal?.aborted).toBe(true);
	});

	it("timed client request: rethrown as the stop, not reported as a timeout", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			createFabricClient({ baseUrl: BASE_URL }).scrapeUrl("u"),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock);
		stop();

		expect(await running).toBe(stopError);
	});

	it("streamed pattern: the stream's body read aborts on the stop", async () => {
		// A real server and the real fetch: the body read is what must abort.
		vi.unstubAllGlobals();
		let server: Server | undefined;
		try {
			server = createServer((_request, response) => {
				response.writeHead(200, {
					"content-type": "text/event-stream",
				});
				response.write(
					`${JSON.stringify({ type: "content", content: "first" })}\n`,
				);
				// Never ends: only an abort releases the reader.
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const { port } = server.address() as AddressInfo;
			const { guard, stop, stopError } = createGuard();

			const outcome = await runWithDispatchGuard(guard, async () => {
				const stream = createFabricClient({
					baseUrl: `http://127.0.0.1:${port}`,
				}).executePatternStream({ input: "i", pattern: "summarize" });
				const first = await stream.next();
				stop();
				const second = await stream
					.next()
					.catch((caught: unknown) => caught);
				return { first, second };
			});

			expect(outcome.first.value).toEqual({
				type: "content",
				content: "first",
			});
			expect(outcome.second).toBe(stopError);
		} finally {
			server?.closeAllConnections();
			server?.close();
		}
	});
});

describe("fallback catches rethrow a stop and send no fallback request", () => {
	it("hybrid: a stop while fetching the pattern is not turned into a failed result or a model call", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			executePatternHybrid({
				input: "i",
				pattern: "summarize",
				userContext: USER_CONTEXT,
				fabricConfig: { baseUrl: BASE_URL },
			}),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock);
		stop();

		expect(await running).toBe(stopError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(hoisted.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("hybrid: a stop while fetching an optional context does not carry on without it", async () => {
		fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
			if (String(url).includes("/patterns/")) {
				return Response.json({ Pattern: "pattern body" });
			}
			return hangingFetch()(url, init);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			executePatternHybrid({
				input: "i",
				pattern: "summarize",
				context: "example-context",
				userContext: USER_CONTEXT,
				fabricConfig: { baseUrl: BASE_URL },
			}),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock, 2);
		stop();

		expect(await running).toBe(stopError);
		expect(hoisted.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("delegated: a stop during the support probe does not fall back to hybrid", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError, assertDispatchable } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			executeFabricPattern({
				mode: "delegated",
				input: "i",
				pattern: "summarize",
				userContext: USER_CONTEXT,
				fabricConfig: { baseUrl: BASE_URL },
			}),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock);
		stop();

		expect(await running).toBe(stopError);
		// Only the probe: no hybrid pattern request is even attempted after
		// it (the hybrid request's own check would refuse it, so the check
		// count is what shows the fallback was not taken).
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(assertDispatchable).toHaveBeenCalledTimes(1);
		expect(urlOf(fetchMock.mock.calls[0])).toBe(
			`${BASE_URL}/chat/delegated`,
		);
	});

	it("delegated: a stop during the delegated chat request is not a failed result", async () => {
		hoisted.getAIModelWithMetadata.mockResolvedValue({
			model: languageModel(),
			metadata: {
				modelString: "openai/gpt-example",
				provider: "OPENAI_DIRECT",
			},
			trackUsage: vi.fn(),
		});
		fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
			if (init?.method === "OPTIONS") {
				return new Response(null, { status: 405 });
			}
			return hangingFetch()(url, init);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			executeFabricPattern({
				mode: "delegated",
				input: "i",
				pattern: "summarize",
				userContext: USER_CONTEXT,
				fabricConfig: { baseUrl: BASE_URL },
			}),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock, 2);
		stop();

		expect(await running).toBe(stopError);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("full: a stop during /chat is not a failed result", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			executePatternFull({
				input: "i",
				pattern: "summarize",
				fabricConfig: { baseUrl: BASE_URL },
			}),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock);
		stop();

		expect(await running).toBe(stopError);
	});

	it("delegated transcription: a stop is not a failed result and does not fall back to hybrid", async () => {
		const doGenerate = vi.fn(async () => {
			throw new Error("hybrid transcription must not run");
		});
		hoisted.transcriptionModel.current = new MockTranscriptionModelV4({
			doGenerate,
		});
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, stop, stopError } = createGuard();

		const running = runWithDispatchGuard(guard, () =>
			transcribeAudio(Buffer.from("audio"), "meeting.mp3", {
				mode: "delegated",
				userContext: USER_CONTEXT,
				fabricConfig: { baseUrl: BASE_URL },
			}),
		).catch((caught: unknown) => caught);
		await waitForCalls(fetchMock);
		stop();

		expect(await running).toBe(stopError);
		expect(doGenerate).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("with no guard, behaviour is unchanged", () => {
	it("a failed delegated probe still falls back to hybrid", async () => {
		hoisted.getAIModelWithMetadata.mockResolvedValue({
			model: languageModel(),
			metadata: { modelString: "openai/gpt-example" },
			trackUsage: vi.fn(),
		});
		fetchMock.mockImplementation(async (url: unknown) => {
			if (String(url).endsWith("/chat/delegated")) {
				throw new TypeError("fetch failed");
			}
			return Response.json({ Pattern: "pattern body" });
		});

		const result = await executeFabricPattern({
			mode: "delegated",
			input: "i",
			pattern: "summarize",
			userContext: USER_CONTEXT,
			fabricConfig: { baseUrl: BASE_URL },
		});

		expect(result).toMatchObject({
			success: true,
			output: "analysis",
			mode: "hybrid",
		});
		expect(urlOf(fetchMock.mock.calls[1])).toBe(
			`${BASE_URL}/patterns/summarize`,
		);
	});

	it("a failed Jina request is still a { success: false } result", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		const result = await createJinaClient({ apiKey: "example" }).search(
			"q",
		);

		expect(result).toEqual({
			content: "",
			success: false,
			error: "fetch failed",
		});
	});

	it("raw requests are sent with no signal, as before", async () => {
		fetchMock.mockResolvedValue(Response.json({ content: "results" }));

		await createFabricClient({ baseUrl: BASE_URL }).searchWebDelegated(
			"q",
			"t",
		);

		expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(
			undefined,
		);
	});

	it("the client's own timeout still reports a timeout", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);

		const error = await createFabricClient({
			baseUrl: BASE_URL,
			timeout: 20,
		})
			.scrapeUrl("u")
			.catch((caught: unknown) => caught);

		expect((error as Error).message).toBe("Fabric API timeout after 20ms");
	});

	it("inside a guard that is not stopped, the client's own timeout is still a timeout, not a stop", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard } = createGuard();

		const error = await runWithDispatchGuard(guard, () =>
			createFabricClient({ baseUrl: BASE_URL, timeout: 20 }).scrapeUrl(
				"u",
			),
		).catch((caught: unknown) => caught);

		expect((error as Error).message).toBe("Fabric API timeout after 20ms");
	});

	it("inside a guard that is not stopped, a Jina timeout is still a { success: false } result", async () => {
		fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard } = createGuard();

		const result = await runWithDispatchGuard(guard, () =>
			createJinaClient({ apiKey: "example", timeout: 20 }).search("q"),
		);

		expect(result.success).toBe(false);
	});
});
