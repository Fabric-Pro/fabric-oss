/**
 * Advisor Stop during a Fabric AI tool (web search, scraping, patterns).
 *
 * These activities run inside `executeMcpTool`, under the chat turn's
 * dispatch guard, and each of them catches failures: a failed provider
 * search or scrape falls back to the Fabric AI server, and the outer catch
 * returns `{ success: false }`, which `executeMcpTool` would hand to the
 * model as a tool error. In a turn (run here with the real turn guard, as the
 * worker's interceptor runs it) a stop must leave the activity as an error
 * and start no fallback; with no turn the fallbacks are unchanged.
 *
 * `fetch` is mocked at the global boundary and `@repo/fabric-ai` is real.
 * The search provider is a stub (search providers send their own requests
 * and take no abort signal), so a search stop is delivered as a cancellation
 * while the stub is pending.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	getEffectiveDelegationSetting: vi.fn(),
	getEnabledOrganizationSearchProviders: vi.fn(),
	getEnabledUserSearchProviders: vi.fn(),
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	providerSearch: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	issueAIToken: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: h.checkDispatchable,
	getEffectiveDelegationSetting: h.getEffectiveDelegationSetting,
	getEnabledOrganizationSearchProviders:
		h.getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders: h.getEnabledUserSearchProviders,
	getMergedSearchProviderConfigs: h.getMergedSearchProviderConfigs,
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
vi.mock("@repo/search", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/search")>()),
	createProvider: () => ({ search: h.providerSearch }),
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
	h.getSearchProviderConfig.mockResolvedValue(null);
	// Rows exist for the turn's organization only.
	h.getMergedSearchProviderConfigs.mockImplementation(
		async (args: { organizationId?: string | null }) =>
			args.organizationId === USER.organizationId
				? [
						{
							providerName: "exa",
							encryptedApiKey: "exa-key",
							endpoint: null,
							enabled: true,
							isDefault: true,
							priority: 0,
							source: "organization",
						},
					]
				: [],
	);
	// Scraping resolves its provider through getWebScraperForTenant: an
	// organization with Jina as its default scraper.
	const jinaProviderRow = {
		providerName: "jina",
		encryptedApiKey: "jina-key",
		endpoint: null,
		enabled: true,
		isDefault: true,
		priority: 0,
		createdAt: new Date(),
	};
	h.getEnabledOrganizationSearchProviders.mockResolvedValue([
		jinaProviderRow,
	]);
	h.getEnabledUserSearchProviders.mockResolvedValue([jinaProviderRow]);
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

/**
 * Like `cancelDuringFirstRequest`, for a search the stubbed provider is
 * serving: the provider search stays pending until the Stop reaches the
 * activity, then fails the way a dropped connection would.
 */
async function cancelDuringProviderSearch(
	body: () => Promise<unknown>,
): Promise<unknown> {
	const env = new MockActivityEnvironment();
	let fail: (error: Error) => void = () => undefined;
	h.providerSearch.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);
	const running = env
		.run(() => runWithTurnDispatch(TURN_SCOPE, body))
		.then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
	await vi.waitFor(() => expect(h.providerSearch).toHaveBeenCalledTimes(1));
	env.cancel();
	fail(new TypeError("fetch failed"));
	return running;
}

describe("a Stop while a Fabric AI tool's request is in flight", () => {
	it("web search: a provider failure after the Stop is not a { success: false } result", async () => {
		const outcome = await cancelDuringProviderSearch(() =>
			searchWebActivity({ question: "q", ...USER }),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.providerSearch).toHaveBeenCalledTimes(1);
		expect(h.getMergedSearchProviderConfigs).toHaveBeenCalledWith(USER);
		// No fallback to the Fabric AI server.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("search and analyze: no fallback search and no analysis", async () => {
		const outcome = await cancelDuringProviderSearch(() =>
			searchAndAnalyzeActivity({
				question: "q",
				pattern: "summarize",
				...USER,
			}),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.providerSearch).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
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
		expect(String(fetchMock.mock.calls[0][0])).toContain("r.jina.ai");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("scrape URL: a stopped Jina scrape is not a { success: false } result", async () => {
		const outcome = await cancelDuringFirstRequest(() =>
			scrapeUrlActivity({ url: "https://example.com/page", ...USER }),
		);

		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.getEnabledOrganizationSearchProviders).toHaveBeenCalledWith(
			"org-example-1",
		);
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
		expect(h.providerSearch).not.toHaveBeenCalled();
	});

	it("search and analyze: the provider search is not started", async () => {
		h.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const outcome = await runWithTurnDispatch(TURN_SCOPE, () =>
			searchAndAnalyzeActivity({
				question: "q",
				pattern: "summarize",
				...USER,
			}),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.providerSearch).not.toHaveBeenCalled();
		expect(h.getAIModelWithMetadata).not.toHaveBeenCalled();
	});
});

describe("with no turn, the fallbacks are unchanged", () => {
	it("search and analyze: a failed provider search still falls back to the Fabric AI server", async () => {
		expect(getDispatchGuard()).toBeUndefined();
		h.providerSearch.mockRejectedValue(new TypeError("fetch failed"));
		h.getAIModelWithMetadata.mockRejectedValue(new Error("model stub"));
		fetchMock.mockImplementation(
			async () => new Response('{"content":"server results"}'),
		);

		await searchAndAnalyzeActivity({
			question: "q",
			pattern: "summarize",
			...USER,
		});

		expect(h.providerSearch).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain("/search");
	});

	it("web search: a failure everywhere is still a { success: false } result", async () => {
		h.providerSearch.mockRejectedValue(new TypeError("fetch failed"));

		const result = await searchWebActivity({ question: "q", ...USER });

		expect(result).toMatchObject({ success: false, error: "fetch failed" });
	});
});
