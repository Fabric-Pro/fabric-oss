import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return { ...actual, Context: { current: () => ({ heartbeat: vi.fn() }) } };
});
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		log: vi.fn(),
	},
}));
const backend = vi.hoisted(() => ({
	getMcpClientResult: vi.fn(),
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@repo/agent-core/backend", () => backend);
const analyzer = vi.hoisted(() => ({ analyzePMToolCapabilities: vi.fn() }));
vi.mock("../tool-analyzer", () => analyzer);
const exec = vi.hoisted(() => ({ executeMcpTool: vi.fn() }));
vi.mock("../../orchestrator/execution/execute-mcp-tool", () => exec);
const mcp = vi.hoisted(() => ({
	getCachedMcpClientForConfig: vi.fn(),
	// Production returns `Promise<void>` (the code does
	// `invalidateMcpClientCache(...).catch(...)`); mirror that so `.catch` is a
	// function, not `undefined`.
	invalidateMcpClientCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@repo/mcp", () => mcp);
vi.mock("../../pm-source", () => ({
	resolvePmSource: vi.fn(),
	resolvePmServerKey: vi.fn(),
	PMSourceNotFound: class extends Error {},
}));

const FIZZY_CAPS = {
	hasPMCapabilities: true,
	detectedType: "fizzy",
	containerHierarchy: [],
	availableTools: ["fizzy_get_card"],
	taskGet: {
		toolName: "fizzy_get_card",
		idParam: "card_number",
		additionalRequiredParams: [],
		allParams: [],
	},
};

function healthyDiscovery() {
	backend.getMcpClientResult.mockResolvedValue({
		ok: true,
		client: { tools: async () => ({ fizzy_get_card: {} }) },
		serverName: "Fizzy",
	});
	analyzer.analyzePMToolCapabilities.mockReturnValue(FIZZY_CAPS);
}

const baseInput = {
	mcpConfigId: "cfg1",
	containerId: "board1",
	additionalContext: { account_slug: "acme" }, // present → no slug probe
	userId: "u1",
};

describe("fetchPMItemsByIds bounded fetch", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("forwards callTimeoutMs to each per-card call; a timed-out card is a failedId, not notFound; items keep input order", async () => {
		healthyDiscovery();
		exec.executeMcpTool.mockImplementation(
			async (input: { args: Record<string, unknown> }) => {
				const id = String(input.args.card_number);
				if (id === "2") {
					return {
						success: false,
						output: {
							error: 'MCP tool "fizzy_get_card" timed out after 20000ms',
						},
						durationMs: 1,
						cached: false,
					};
				}
				return {
					success: true,
					output: {
						title: `T${id}`,
						description: "d",
						_links: { html: { href: `https://f/${id}` } },
					},
					durationMs: 1,
					cached: false,
				};
			},
		);
		const { fetchPMItemsByIds } = await import("../story-sync");
		const res = await fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1", "2", "3"],
			concurrency: 2,
			callTimeoutMs: 20_000,
		});
		expect(exec.executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 20_000 }),
		);
		expect(res.items.map((i) => i.id)).toEqual(["1", "3"]);
		expect(res.failedIds).toContain("2");
		expect(res.notFoundIds ?? []).not.toContain("2");
		expect(res.failedIdErrors?.["2"]).toMatch(/timed out/i);
	});

	it("budget=0 skips every card as a transient failedId, calling no per-card tool", async () => {
		healthyDiscovery();
		const { fetchPMItemsByIds } = await import("../story-sync");
		const res = await fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1", "2"],
			concurrency: 2,
			callTimeoutMs: 20_000,
			budgetMs: 0,
		});
		expect(exec.executeMcpTool).not.toHaveBeenCalled();
		expect(res.items).toEqual([]);
		expect([...(res.failedIds ?? [])].sort()).toEqual(["1", "2"]);
		expect(res.notFoundIds ?? []).toEqual([]);
		expect(res.failedIdErrors?.["1"]).toMatch(/budget/i);
	});

	it("discovery timeout → empty partial AND closes the discovery client even when tools() hangs forever (finding 10)", async () => {
		vi.useFakeTimers();
		// Client connects, but the tool LIST hangs forever. The internal timeout
		// wins the race; the client is already assigned, so the OUTER post-race
		// finally must close it (aborting the hung request) WITHOUT waiting for
		// the detached discover() to settle — which it never will.
		backend.getMcpClientResult.mockResolvedValue({
			ok: true,
			client: { tools: () => new Promise(() => {}) }, // never settles
			serverName: "Fizzy",
		});
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1", "2"],
			concurrency: 2,
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		const res = await p;
		expect(exec.executeMcpTool).not.toHaveBeenCalled();
		expect(res.items).toEqual([]);
		expect([...(res.failedIds ?? [])].sort()).toEqual(["1", "2"]);
		expect(res.notFoundIds ?? []).toEqual([]);
		expect(res.failedIdErrors?.["1"]).toMatch(/discovery/i);
		// Closed at timeout via the outer finally, while tools() is still hung —
		// NOT deferred until discover() settles (it never does).
		expect(backend.closeMcpClientSafe).toHaveBeenCalled();
	});

	it("discovery timeout does NOT touch the shared cache when the refresh-retry borrowed a fromCache client, and still closes its own client (findings 11, 15)", async () => {
		vi.useFakeTimers();
		// First (non-cached) discovery client returns EMPTY tools → triggers the
		// OAuth-refresh retry, which BORROWS a shared `fromCache: true` client whose
		// tools() hangs forever. That borrowed client may be in use by an unrelated
		// concurrent MCP call, so our timeout must NOT close/evict it — only the
		// client this discovery exclusively owns (the non-cached one) is closed.
		backend.getMcpClientResult.mockResolvedValue({
			ok: true,
			client: { tools: async () => ({}) },
			serverName: "Fizzy",
		});
		mcp.getCachedMcpClientForConfig.mockResolvedValue({
			client: { tools: () => new Promise(() => {}) }, // never settles
			serverName: "Fizzy",
			fromCache: true, // SHARED — an unrelated concurrent call may hold it
		});
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		const res = await p;
		expect(res.items).toEqual([]); // clean empty partial — poll keeps progressing
		expect(mcp.invalidateMcpClientCache).not.toHaveBeenCalled(); // shared cache untouched
		expect(backend.closeMcpClientSafe).toHaveBeenCalled(); // own (non-cached) client closed
	});

	it("does not start the refresh-retry tools() after the discovery timeout already fired (finding 16)", async () => {
		vi.useFakeTimers();
		// First discovery client returns EMPTY tools → enters the refresh-retry.
		backend.getMcpClientResult.mockResolvedValue({
			ok: true,
			client: { tools: async () => ({}) },
			serverName: "Fizzy",
		});
		// The refresh-retry BORROW (getCachedMcpClientForConfig) is the slow step: it
		// stays pending past the discovery timeout, then resolves LATE with a client
		// whose tools() would hang. The detached discover() must re-check timedOut and
		// bail BEFORE starting that new tools() call (the finding-13 analogue).
		let resolveBorrow: (v: unknown) => void = () => {};
		const retryTools = vi.fn(() => new Promise(() => {})); // would hang if ever called
		mcp.getCachedMcpClientForConfig.mockReturnValue(
			new Promise((res) => {
				resolveBorrow = res;
			}),
		);
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000); // timeout fires during the slow borrow
		const res = await p;
		expect(res.items).toEqual([]);
		// Borrow resolves LATE, after the timeout path already returned:
		resolveBorrow({
			client: { tools: retryTools },
			serverName: "Fizzy",
			fromCache: false,
		});
		await vi.runAllTimersAsync();
		await Promise.resolve();
		await Promise.resolve();
		// The detached discover() bailed on timedOut → never started a new tools():
		expect(retryTools).not.toHaveBeenCalled();
	});

	it("does not start the refresh-retry borrow when the first tools() resolves empty AFTER the timeout fired (finding 17)", async () => {
		vi.useFakeTimers();
		// The FIRST owned tools() is the slow step: it stays pending past the
		// discovery timeout, then resolves LATE with an empty tool list. The detached
		// discover() must bail before entering the refresh-retry borrow — which is
		// itself an MCP/cache-mutating op, not a pure read.
		let resolveFirstTools: (v: unknown) => void = () => {};
		backend.getMcpClientResult.mockResolvedValue({
			ok: true,
			client: {
				tools: () =>
					new Promise((res) => {
						resolveFirstTools = res;
					}),
			},
			serverName: "Fizzy",
		});
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000); // timeout fires while first tools() pending
		const res = await p;
		expect(res.items).toEqual([]);
		// First tools() resolves LATE with EMPTY tools, after the timeout returned —
		// WITHOUT the pre-borrow guard this would enter the refresh-retry borrow:
		resolveFirstTools({});
		await vi.runAllTimersAsync();
		await Promise.resolve();
		await Promise.resolve();
		// The detached discover() bailed on timedOut → never started the borrow:
		expect(mcp.getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("closes a discovery client that connects AFTER the timeout fired (late-connect race)", async () => {
		vi.useFakeTimers();
		// The connect itself (not tools()) is the slow step here: it stays
		// pending past the discovery timeout, then resolves later — simulating
		// a client that loses the timeout race but still shows up afterward.
		let resolveConnect: (v: unknown) => void = () => {};
		backend.getMcpClientResult.mockReturnValue(
			new Promise((res) => {
				resolveConnect = res;
			}),
		);
		analyzer.analyzePMToolCapabilities.mockReturnValue(FIZZY_CAPS);
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000); // timeout fires while still "connecting"
		const res = await p; // returns empty partial (discovery timed out)
		expect(res.items).toEqual([]);
		// connect resolves LATE, after the timeout path already returned:
		resolveConnect({
			ok: true,
			client: { tools: async () => ({ fizzy_get_card: {} }) },
			serverName: "Fizzy",
		});
		await vi.runAllTimersAsync();
		await Promise.resolve(); // flush the detached discover() microtasks
		expect(backend.closeMcpClientSafe).toHaveBeenCalled(); // late client still closed
	});

	it("closes a late-connect client even when its tools() then hangs forever (finding 13)", async () => {
		vi.useFakeTimers();
		// Compound race: the connect is slow (times out), then resolves late with
		// a client whose tools() NEVER settles. The outer finally already ran
		// (client was undefined); discover() would hang in tools() and never reach
		// its own finally — so discover() must bail via the timed-out check right
		// after assigning the client, closing it exactly once.
		let resolveConnect: (v: unknown) => void = () => {};
		backend.getMcpClientResult.mockReturnValue(
			new Promise((res) => {
				resolveConnect = res;
			}),
		);
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000); // timeout fires DURING connect
		const res = await p;
		expect(res.items).toEqual([]);
		// connect resolves LATE with a client whose tools() never settles:
		resolveConnect({
			ok: true,
			client: { tools: () => new Promise(() => {}) },
			serverName: "Fizzy",
		});
		await vi.runAllTimersAsync();
		await Promise.resolve();
		await Promise.resolve();
		expect(backend.closeMcpClientSafe).toHaveBeenCalledTimes(1); // closed exactly once, not leaked
	});

	it("does NOT invalidate the shared cache when discovery times out before any refresh-retry (finding 14)", async () => {
		vi.useFakeTimers();
		// The FIRST tools() hangs, so the timeout fires before the empty-tools
		// refresh-retry ever opens a cached client. The non-cached discovery client
		// is never in the shared cache, so invalidating here would only evict/close
		// a cached client an unrelated concurrent MCP call is using.
		backend.getMcpClientResult.mockResolvedValue({
			ok: true,
			client: { tools: () => new Promise(() => {}) }, // never settles
			serverName: "Fizzy",
		});
		const { fetchPMItemsByIds } = await import("../story-sync");
		const p = fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		const res = await p;
		expect(res.items).toEqual([]);
		// Refresh-retry never ran → nothing this discovery created to invalidate.
		expect(mcp.invalidateMcpClientCache).not.toHaveBeenCalled();
		// The discovery client is still closed (via the outer finally / close-once).
		expect(backend.closeMcpClientSafe).toHaveBeenCalled();
	});

	it("charges pre-pool discovery time against the budget deadline (DEC-7, finding 9)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		// Discovery resolves, but "takes" 120s of wall time (advances the clock).
		backend.getMcpClientResult.mockImplementation(async () => {
			vi.setSystemTime(120_000);
			return {
				ok: true,
				client: { tools: async () => ({ fizzy_get_card: {} }) },
				serverName: "Fizzy",
			};
		});
		analyzer.analyzePMToolCapabilities.mockReturnValue(FIZZY_CAPS);
		const { fetchPMItemsByIds } = await import("../story-sync");
		const res = await fetchPMItemsByIds({
			...baseInput,
			externalIds: ["1", "2"],
			concurrency: 2,
			callTimeoutMs: 20_000,
			budgetMs: 100_000, // deadlineAt = entry(0) + 100_000; discovery ate 120_000 > deadline
		});
		expect(exec.executeMcpTool).not.toHaveBeenCalled(); // pool deadline already passed
		expect(res.items).toEqual([]);
		expect([...(res.failedIds ?? [])].sort()).toEqual(["1", "2"]);
		expect(res.failedIdErrors?.["1"]).toMatch(/budget/i);
	});
});
