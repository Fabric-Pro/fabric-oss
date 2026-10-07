/**
 * Advisor Stop during a Fabric AI tool (web search, scraping, patterns).
 *
 * These activities run inside `executeMcpTool`, under the chat turn's
 * dispatch guard, and each of them catches failures: a delegated request
 * that fails falls back to the user's Jina key and then to the Fabric AI
 * server, and the outer catch returns `{ success: false }`, which
 * `executeMcpTool` would hand to the model as a tool error. In a turn
 * (run here with the real turn guard, as the worker's interceptor runs it) a
 * stop must leave the activity as an error and start no fallback; with no
 * turn the fallbacks are unchanged.
 *
 * `fetch` is mocked at the global boundary; `@repo/fabric-ai` is real.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	getEffectiveDelegationSetting: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	issueAIToken: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: h.checkDispatchable,
	getEffectiveDelegationSetting: h.getEffectiveDelegationSetting,
	getSearchProviderConfig: h.getSearchProviderConfig,
	logAiUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: h.getAIModelWithMetadata,
	getSystemRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "example-provider-key",
		provider: "OPENAI_DIRECT",
	}),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: h.issueAIToken }));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted-${value}`,
}));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_operation: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));

import { runWithTurnDispatch } from "../../orchestrator/turn-dispatch";
import {
	executeFabricPattern,
	scrapeAndAnalyzeActivity,
	scrapeUrlActivity,
	searchAndAnalyzeActivity,
	searchWebActivity,
} from "../index";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const USER = { userId: "user-example-1", organizationId: "org-example-1" };

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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	for (const mock of Object.values(h)) {
		mock.mockReset();
	}
	h.checkDispatchable.mockResolvedValue({ ok: true });
	h.getEffectiveDelegationSetting.mockResolvedValue(true);
	h.getSearchProviderConfig.mockResolvedValue({
		encryptedApiKey: "jina-key",
		enabled: true,
		source: "user",
	});
	h.issueAIToken.mockResolvedValue("example-ai-token");
	fetchMock = hangingFetch();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/**
 * Runs `body` as a turn-scoped activity, cancels the activity (the Stop
 * reaching it on a heartbeat) once the first request is in flight, and
 * returns what the activity settled with.
 */
async function cancelDuringFirstRequest(
	body: () => Promise<unknown>,
): Promise<unknown> {
	const env = new MockActivityEnvironment();
	const running = env
		.run(() => runWithTurnDispatch(TURN_SCOPE, body))
		.then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	env.cancel();
	return running;
}

describe("a Stop while a Fabric AI tool's request is in flight", () => {
	it("web search: the delegated request is aborted and no fallback runs", async () => {
		const outcome = await cancelDuringFirstRequest(() =>
			searchWebActivity({ question: "q", ...USER }),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"/delegated/search",
		);
		expect(
			(fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted,
		).toBe(true);
		// The delegated catch did not go on to the user's Jina key or the
		// Fabric AI server.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(h.getSearchProviderConfig).not.toHaveBeenCalled();
	});

	it("search and analyze: no fallback search and no analysis", async () => {
		const outcome = await cancelDuringFirstRequest(() =>
			searchAndAnalyzeActivity({
				question: "q",
				pattern: "summarize",
				...USER,
			}),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(h.getSearchProviderConfig).not.toHaveBeenCalled();
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("scrape and analyze: no fallback scrape and no analysis", async () => {
		const outcome = await cancelDuringFirstRequest(() =>
			scrapeAndAnalyzeActivity({
				url: "https://example.com/page",
				pattern: "summarize",
				...USER,
			}),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(h.getSearchProviderConfig).not.toHaveBeenCalled();
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("scrape URL: a stopped Jina scrape is not a { success: false } result", async () => {
		const outcome = await cancelDuringFirstRequest(() =>
			scrapeUrlActivity({ url: "https://example.com/page", ...USER }),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(String(fetchMock.mock.calls[0][0])).toContain("r.jina.ai");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("pattern: a stopped pattern request is not a { success: false } result", async () => {
		const outcome = await cancelDuringFirstRequest(() =>
			executeFabricPattern({
				pattern: "summarize",
				input: "launch notes",
				mode: "hybrid",
				...USER,
			}),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});
});

describe("a Stop recorded before a Fabric AI tool's request", () => {
	it("web search: the request is refused before it is sent", async () => {
		h.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const outcome = await runWithTurnDispatch(TURN_SCOPE, () =>
			searchWebActivity({ question: "q", ...USER }),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect((outcome as ApplicationFailure).type).toBe(
			"TurnNotDispatchable",
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.getSearchProviderConfig).not.toHaveBeenCalled();
	});
});

describe("with no turn, the fallbacks are unchanged", () => {
	it("web search: a failed delegated request still falls back to the user's Jina key", async () => {
		expect(getDispatchGuard()).toBeUndefined();
		fetchMock.mockImplementation(async (url: unknown) => {
			if (String(url).includes("/delegated/search")) {
				throw new TypeError("fetch failed");
			}
			return new Response("search results", { status: 200 });
		});

		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({
			success: true,
			results: "search results",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1][0])).toContain("s.jina.ai");
	});

	it("web search: a failure everywhere is still a { success: false } result", async () => {
		h.getEffectiveDelegationSetting.mockResolvedValue(false);
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({ success: false, error: "fetch failed" });
	});
});
