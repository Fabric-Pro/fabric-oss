/**
 * The Letta client sends no write once the Advisor chat turn it runs in has
 * stopped — including the writes it makes on its own after awaiting
 * something: `updateMemoryBlock` falls back, after a 404, to listing the
 * agent's blocks and PATCHing the block by id.
 *
 * The real `LettaClient` runs here; only Letta's HTTP (`fetch`) is
 * simulated. The stop latches while the block list is read, after the
 * caller's own check and the first PATCH. The check that holds is the
 * client's: every request that changes something on the server checks the
 * turn synchronously before it is sent, and the fallback hands the stop
 * back instead of turning it into "Failed to update memory block".
 */

import { LettaClient } from "@repo/letta";
import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	/** Each request Letta received, as "METHOD /path". */
	requests: [] as string[],
	/** Runs while the block list is read; the test stops the turn there. */
	duringBlockList: undefined as (() => void) | undefined,
	stopped: false,
}));

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Letta, simulated: the label endpoint 404s, the block exists by id. */
async function letta(input: unknown, init?: RequestInit): Promise<Response> {
	const url = new URL(
		typeof input === "string" ? input : (input as Request).url,
	);
	const method = (init?.method ?? "GET").toUpperCase();
	h.requests.push(`${method} ${url.pathname}`);
	await Promise.resolve();
	if (url.pathname.endsWith("/core-memory/blocks/tool_cache")) {
		return json({ detail: "not found" }, 404);
	}
	if (method === "GET" && url.pathname.endsWith("/core-memory/blocks")) {
		h.duringBlockList?.();
		return json([{ id: "block-example-1", label: "tool_cache" }]);
	}
	if (method === "PATCH" && url.pathname === "/v1/blocks/block-example-1") {
		return json({ id: "block-example-1", label: "tool_cache", value: "x" });
	}
	return json({}, 500);
}

const STOP = new Error("the chat turn stopped");

const guard: DispatchGuard = {
	key: "turn-example-1",
	assertDispatchable: async () => undefined,
	abortSignal: () => undefined,
	rethrowIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
	throwIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
};

const client = new LettaClient({ baseUrl: "http://letta.example.com" });

beforeEach(() => {
	h.requests = [];
	h.duringBlockList = undefined;
	h.stopped = false;
	vi.stubGlobal("fetch", vi.fn(letta));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("LettaClient.updateMemoryBlock inside a chat turn", () => {
	it("falls back to the block's id after a 404 when nothing stops the turn", async () => {
		await expect(
			runWithDispatchGuard(guard, () =>
				client.updateMemoryBlock("agent-example-1", "tool_cache", "x"),
			),
		).resolves.toMatchObject({ id: "block-example-1" });
		expect(h.requests).toEqual([
			"PATCH /v1/agents/agent-example-1/core-memory/blocks/tool_cache",
			"GET /v1/agents/agent-example-1/core-memory/blocks",
			"PATCH /v1/blocks/block-example-1",
		]);
	});

	it("sends no second PATCH when the turn stops while the block list is read, and fails with the stop", async () => {
		h.duringBlockList = () => {
			h.stopped = true;
		};
		await expect(
			runWithDispatchGuard(guard, () =>
				client.updateMemoryBlock("agent-example-1", "tool_cache", "x"),
			),
		).rejects.toBe(STOP);
		expect(h.requests).toEqual([
			"PATCH /v1/agents/agent-example-1/core-memory/blocks/tool_cache",
			"GET /v1/agents/agent-example-1/core-memory/blocks",
		]);
	});

	it("still reads after a stop: only writes are refused", async () => {
		h.stopped = true;
		await expect(
			runWithDispatchGuard(guard, () =>
				client.getAllMemoryBlocks("agent-example-1"),
			),
		).resolves.toEqual([{ id: "block-example-1", label: "tool_cache" }]);
	});
});
