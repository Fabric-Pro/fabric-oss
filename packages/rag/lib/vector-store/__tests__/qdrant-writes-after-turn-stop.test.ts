/**
 * Inside an Advisor chat turn that has stopped, Qdrant receives none of the
 * turn's own content writes (a capability upsert's points), and one turn's
 * stop never fails provisioning other callers share.
 *
 * The real capability store, collection manager and Qdrant client run here;
 * only Qdrant's HTTP (`fetch`) is simulated. Content writes are refused by
 * the Qdrant client's own check, synchronously before it sends. Collection
 * provisioning (creating the collection, its payload indexes, enabling
 * sparse vectors) carries no turn's content and is shared between callers
 * through one in-flight promise, so it runs outside every turn's guard: a
 * stopped turn still provisions, and only its point write is refused.
 */

import {
	type DispatchGuard,
	getDispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertCapabilities } from "../capability-store";

const h = vi.hoisted(() => {
	// Installed before the client module loads: its constructor already
	// asks the server for its version.
	const fetchMock = vi.fn<
		(input: unknown, init?: RequestInit) => Promise<Response>
	>(
		async () =>
			new Response(JSON.stringify({ version: "1.16.0" }), {
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return {
		fetchMock,
		/** Each request Qdrant received, as "METHOD /path". */
		requests: [] as string[],
		/** The guard active when each request was sent ("none" outside one). */
		sentUnder: [] as string[],
		/** Runs while the collection is being created; may hold it open. */
		duringCreate: undefined as (() => Promise<void>) | undefined,
		/** Status for the next collection creation (409: it already exists). */
		createStatus: 200,
		/** Collections that exist on the simulated server. */
		collections: new Set<string>(),
		/** Runs while the named read is in flight; the test stops the turn there. */
		during: {} as Record<string, (() => void) | undefined>,
		stopped: false,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function json(result: unknown): Response {
	return new Response(JSON.stringify({ result, status: "ok", time: 0 }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** Qdrant's REST API, simulated for the calls the collection manager makes. */
async function qdrant(input: unknown, init?: RequestInit): Promise<Response> {
	const url = new URL(
		typeof input === "string" ? input : (input as Request).url,
	);
	const method = (init?.method ?? "GET").toUpperCase();
	const path = url.pathname;
	h.requests.push(`${method} ${path}`);
	h.sentUnder.push(getDispatchGuard()?.key ?? "none");
	await Promise.resolve();
	if (method === "GET" && path === "/") {
		return json({ title: "qdrant", version: "1.16.0" });
	}
	if (method === "GET" && path === "/collections") {
		h.during["collection list"]?.();
		return json({
			collections: [...h.collections].map((name) => ({ name })),
		});
	}
	const name = path.split("/")[2] ?? "";
	if (method === "GET" && path === `/collections/${name}`) {
		h.during["collection info"]?.();
		// An existing collection created before any payload index:
		// preparing it backfills every index.
		return json({
			status: "green",
			config: { params: { vectors: { size: 1536, distance: "Cosine" } } },
			payload_schema: {},
		});
	}
	if (method === "PUT" && path === `/collections/${name}`) {
		await h.duringCreate?.();
		h.collections.add(name);
		if (h.createStatus !== 200) {
			return new Response(
				JSON.stringify({
					status: { error: `Collection ${name} already exists` },
				}),
				{
					status: h.createStatus,
					headers: { "content-type": "application/json" },
				},
			);
		}
		return json(true);
	}
	return json({ operation_id: 1, status: "completed" });
}

const STOP = new Error("the chat turn stopped");

/**
 * A turn's guard. Like the real one, it latches when handed a stop it did
 * not raise itself (`rethrowIfStopped`), which would cancel the turn's
 * other requests.
 */
function turnGuard(key: string, stop: Error = STOP) {
	const state = { stopped: false, latched: false };
	const guard: DispatchGuard = {
		key,
		assertDispatchable: async () => undefined,
		abortSignal: () => undefined,
		rethrowIfStopped: (error) => {
			if (state.stopped || error === stop || error === STOP_A) {
				state.latched = true;
				throw error;
			}
		},
		throwIfStopped: () => {
			if (state.stopped) {
				throw stop;
			}
		},
	};
	return { guard, state };
}

const STOP_A = new Error("turn A stopped");

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

/** Requests that change something on the simulated server. */
function writes(): string[] {
	return h.requests.filter((request) => !request.startsWith("GET "));
}

let orgSeq = 0;
/** A fresh organization per test: the collection manager caches by name. */
function capability() {
	orgSeq += 1;
	return {
		id: `mcp_tool:example:list_issues_${orgSeq}`,
		type: "mcp_tool" as const,
		name: "list_issues",
		description: "Lists issues",
		embedding: [0.1, 0.2, 0.3],
		userId: "user-example-1",
		organizationId: `org-example-${orgSeq}`,
		metadata: { updatedAt: "2026-10-01T00:00:00.000Z" },
	};
}

/** Another capability of the same organization as `item`. */
function sibling(item: ReturnType<typeof capability>, suffix: string) {
	return { ...item, id: `${item.id}_${suffix}` };
}

/** Point writes, as the guard each was sent under. */
function pointWritesUnder(): string[] {
	return h.requests.flatMap((request, index) =>
		request.startsWith("PUT ") && request.endsWith("/points")
			? [h.sentUnder[index] ?? "?"]
			: [],
	);
}

beforeEach(() => {
	h.requests = [];
	h.sentUnder = [];
	h.duringCreate = undefined;
	h.createStatus = 200;
	h.collections = new Set();
	h.during = {};
	h.stopped = false;
	h.fetchMock.mockImplementation(qdrant);
});

afterAll(() => {
	vi.unstubAllGlobals();
});

describe("capability upserts inside a chat turn, against Qdrant's HTTP API", () => {
	it("creates the collection, its indexes and the points when nothing stops the turn", async () => {
		await expect(
			runWithDispatchGuard(guard, () =>
				upsertCapabilities([capability()]),
			),
		).resolves.toEqual({ success: 1, failed: 0 });
		const sent = writes();
		expect(sent[0]).toMatch(/^PUT \/collections\/fabric_capabilities-org-/);
		expect(sent.filter((r) => r.endsWith("/index"))).toHaveLength(5);
		expect(sent.at(-1)).toMatch(/\/points$/);
	});

	it("provisions the collection but writes no point when the turn stops while the collection list is read", async () => {
		h.during["collection list"] = () => {
			h.stopped = true;
		};
		await expect(
			runWithDispatchGuard(guard, () =>
				upsertCapabilities([capability()]),
			),
		).rejects.toBe(STOP);
		const sent = writes();
		expect(sent[0]).toMatch(/^PUT \/collections\/fabric_capabilities-org-/);
		expect(sent.filter((r) => r.endsWith("/index"))).toHaveLength(5);
		expect(sent.filter((r) => r.endsWith("/points"))).toEqual([]);
	});

	it("prepares an existing collection but writes no point when the turn stops while its info is read", async () => {
		const item = capability();
		h.collections.add(`fabric_capabilities-org-${item.organizationId}`);
		h.during["collection info"] = () => {
			h.stopped = true;
		};
		await expect(
			runWithDispatchGuard(guard, () => upsertCapabilities([item])),
		).rejects.toBe(STOP);
		const sent = writes();
		// The index backfill is provisioning and goes out.
		expect(sent.filter((r) => r.endsWith("/index"))).toHaveLength(5);
		expect(sent.filter((r) => r.endsWith("/points"))).toEqual([]);
	});

	it("leaves a write outside any chat turn as it was", async () => {
		h.stopped = true; // no guard is active, so nothing consults this
		await expect(upsertCapabilities([capability()])).resolves.toEqual({
			success: 1,
			failed: 0,
		});
		expect(writes().length).toBeGreaterThan(0);
	});
});

describe("collection provisioning shared between callers", () => {
	it("finishes for every caller when one turn stops while it is in flight: only that turn's point write is refused", async () => {
		const a = turnGuard("turn-a", STOP_A);
		const b = turnGuard("turn-b");
		const item = capability();

		let creating!: () => void;
		const createInFlight = new Promise<void>((resolve) => {
			creating = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.duringCreate = () => {
			creating();
			return released;
		};

		// Turn A starts creating the organization's collection.
		const turnA = runWithDispatchGuard(a.guard, () =>
			upsertCapabilities([item]),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
		await createInFlight;
		// Turn B and an unguarded caller join the same creation.
		const turnB = runWithDispatchGuard(b.guard, () =>
			upsertCapabilities([sibling(item, "b")]),
		);
		const unguarded = upsertCapabilities([sibling(item, "c")]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Turn A stops before the indexes are created.
		a.state.stopped = true;
		release();

		await expect(turnB).resolves.toEqual({ success: 1, failed: 0 });
		await expect(unguarded).resolves.toEqual({ success: 1, failed: 0 });
		expect(await turnA).toBe(STOP_A);
		// B never saw A's stop, so nothing cancelled B's other requests.
		expect(b.state.latched).toBe(false);
		// Every index was created, outside any turn's guard.
		const indexUnder = h.requests.flatMap((request, index) =>
			request.endsWith("/index") ? [h.sentUnder[index]] : [],
		);
		expect(indexUnder).toHaveLength(5);
		expect(new Set(indexUnder)).toEqual(new Set(["none"]));
		// B's and the unguarded caller's points went out; A's did not.
		expect(pointWritesUnder().sort()).toEqual(["none", "turn-b"]);
	});
});

describe("a collection creation that fails", () => {
	it("does not leave a cached 'does not exist' behind, so the next call sees the collection another writer created", async () => {
		const item = capability();
		// Another worker created the collection between this one's list read
		// and its create: Qdrant answers the create with 409.
		h.createStatus = 409;
		await expect(upsertCapabilities([item])).resolves.toEqual({
			success: 0,
			failed: 1,
		});
		h.createStatus = 200;
		h.requests = [];
		await expect(
			upsertCapabilities([sibling(item, "next")]),
		).resolves.toEqual({ success: 1, failed: 0 });
		// Re-read the collection list rather than trusting a cached "missing",
		// and did not try to create it again.
		expect(h.requests).toContain("GET /collections");
		expect(
			h.requests.filter((r) => /^PUT \/collections\/[^/]+$/.test(r)),
		).toEqual([]);
	});
});
