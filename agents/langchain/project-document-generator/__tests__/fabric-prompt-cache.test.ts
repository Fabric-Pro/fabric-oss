/**
 * Fabric AI prompt-fragment cache.
 *
 * `buildSystemPromptAsync` runs once per tool round (up to
 * MAX_TOOL_ITERATIONS + 1 times per run, plus once per retryable model error
 * that re-enters the node). The Fabric AI health probe and the pattern/context
 * fetches behind it depend only on the document type, so they are memoized —
 * these tests pin that the memo actually collapses the round trips, that both
 * TTLs expire, and that concurrent callers share one fetch instead of racing.
 */

import type { ProjectContext } from "@repo/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { httpGet } = vi.hoisted(() => ({ httpGet: vi.fn() }));

vi.mock("node:http", () => {
	class FakeAgent {}
	const mod = { Agent: FakeAgent, get: httpGet };
	return { ...mod, default: mod };
});

vi.mock("node:https", () => {
	class FakeAgent {}
	const mod = { Agent: FakeAgent, get: httpGet };
	return { ...mod, default: mod };
});

type Listener = (...args: unknown[]) => void;

/** Minimal stand-in for the `http.ClientRequest` the module attaches to. */
function fakeRequest() {
	const req = {
		on: () => req,
		destroy: () => {},
	};
	return req;
}

/**
 * Invoke the response callback the way `http.get` does: hand over the response
 * first, then emit `data`/`end` on a later microtask, once the caller has had
 * the chance to register its listeners.
 */
function deliver(statusCode: number, body: string, cb: (res: unknown) => void) {
	const listeners = new Map<string, Listener[]>();
	const res = {
		statusCode,
		resume: () => {},
		on(event: string, listener: Listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			return res;
		},
	};

	cb(res);

	queueMicrotask(() => {
		for (const listener of listeners.get("data") ?? []) {
			listener(body);
		}
		for (const listener of listeners.get("end") ?? []) {
			listener();
		}
	});

	return fakeRequest();
}

/** Stand up a fake Fabric AI server for the module's HTTP client. */
function serve(options: { healthy: boolean }) {
	httpGet.mockImplementation(
		(url: unknown, _options: unknown, cb: (res: unknown) => void) => {
			const path = String(url).replace(/^https?:\/\/[^/]+/, "");

			if (path === "/health") {
				return options.healthy
					? deliver(200, JSON.stringify({ status: "healthy" }), cb)
					: deliver(503, "", cb);
			}
			if (path.startsWith("/patterns/")) {
				return deliver(
					200,
					JSON.stringify({
						Name: path.slice("/patterns/".length),
						Pattern: "FABRIC PATTERN BODY",
					}),
					cb,
				);
			}
			if (path.startsWith("/contexts/")) {
				return deliver(200, JSON.stringify("FABRIC PERSONA BODY"), cb);
			}
			return deliver(404, "", cb);
		},
	);
}

const projectContext: ProjectContext = {
	name: "Example Project",
	techStack: ["React"],
	features: ["Feature 1"],
};

async function loadPrompts() {
	vi.resetModules();
	return await import("../prompts");
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

describe("Fabric AI prompt-fragment cache", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		httpGet.mockReset();
		process.env.FABRIC_AI_URL = "http://fabric-ai.example";
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fetches once and reuses the fragment for every later turn", async () => {
		serve({ healthy: true });
		const { buildSystemPromptAsync } = await loadPrompts();

		const first = await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);

		// health + pattern + context
		expect(httpGet).toHaveBeenCalledTimes(3);
		expect(first).toContain("FABRIC PATTERN BODY");
		expect(first).toContain("FABRIC PERSONA BODY");

		const second = await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);

		expect(httpGet).toHaveBeenCalledTimes(3);
		// The assembled prompt must be byte-identical to the uncached one.
		expect(second).toBe(first);
	});

	it("re-fetches once the 5 minute success TTL has expired", async () => {
		serve({ healthy: true });
		const { buildSystemPromptAsync } = await loadPrompts();

		await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(3);

		vi.advanceTimersByTime(FIVE_MINUTES_MS - 1000);
		await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(3);

		vi.advanceTimersByTime(2000);
		await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(6);
	});

	it("caches an unavailable server for 60 seconds, not longer", async () => {
		serve({ healthy: false });
		const { buildSystemPromptAsync } = await loadPrompts();

		const first = await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);

		// Only the health probe: the pattern/context fetches never happen.
		expect(httpGet).toHaveBeenCalledTimes(1);
		expect(first).not.toContain("FABRIC PATTERN BODY");

		vi.advanceTimersByTime(ONE_MINUTE_MS - 1000);
		const second = await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);

		vi.advanceTimersByTime(2000);
		await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(2);
	});

	it("shares one in-flight fetch between concurrent callers", async () => {
		serve({ healthy: true });
		const { buildSystemPromptAsync } = await loadPrompts();

		const [a, b, c] = await Promise.all([
			buildSystemPromptAsync(
				undefined,
				"prd",
				projectContext,
				[],
				undefined,
			),
			buildSystemPromptAsync(
				undefined,
				"prd",
				projectContext,
				[],
				undefined,
			),
			buildSystemPromptAsync(
				undefined,
				"prd",
				projectContext,
				[],
				undefined,
			),
		]);

		expect(httpGet).toHaveBeenCalledTimes(3);
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	it("keys the cache by pattern, so another document type fetches its own", async () => {
		serve({ healthy: true });
		const { buildSystemPromptAsync } = await loadPrompts();

		await buildSystemPromptAsync(
			undefined,
			"prd",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(3);

		// architecture -> create_design_document / senior_dev
		await buildSystemPromptAsync(
			undefined,
			"architecture",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(6);

		// technical_spec resolves to the same pattern/context pair as
		// architecture, so it must hit the cache.
		await buildSystemPromptAsync(
			undefined,
			"technical_spec",
			projectContext,
			[],
			undefined,
		);
		expect(httpGet).toHaveBeenCalledTimes(6);
	});
});
