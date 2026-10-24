/**
 * Tests for `realtime-emit`.
 *
 * This module hosts the realtime helpers that BOTH `@repo/api` and
 * `@repo/temporal` consume to push `message_appended` events into a
 * per-conversation Upstash Realtime channel. It lives in `@repo/utils`
 * (rather than `@repo/api`) so `@repo/temporal` can static-import it —
 * the previous `await import(["@repo","api","lib","realtime"].join("/"))`
 * workaround silently failed at runtime because `@repo/api` is not
 * declared in `packages/temporal/package.json` dependencies.
 *
 * Test surface:
 *   - `getConversationChannelName(id)` returns `conversation:${id}`
 *   - `emitConversationMessageAppended` with a configured realtime client
 *     invokes `channel(...).emit("message_appended", payload)` once with
 *     the right channel + payload shape
 *   - When the realtime client cannot be constructed (env vars absent),
 *     the helper is a NO-OP — never throws, never logs an error.
 *   - When `channel.emit` rejects, the error is swallowed (best-effort:
 *     a Redis blip MUST NOT crash a Temporal activity).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

/** What turns the web relay on; unset unless a test sets it. */
const RELAY_ENV = [
	"AGENT_SERVICE_SECRET",
	"FABRIC_INTERNAL_URL",
	"RUNTIME_API_URL",
	"APP_URL",
	"NEXT_PUBLIC_APP_URL",
] as const;

beforeEach(() => {
	vi.resetModules();
	process.env = { ...originalEnv };
	for (const name of RELAY_ENV) {
		delete process.env[name];
	}
	// No test here may reach the network.
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	process.env = originalEnv;
	vi.resetModules();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("getConversationChannelName", () => {
	it("returns the conversation: prefixed channel name", async () => {
		const mod = await import("../lib/realtime-emit");
		expect(mod.getConversationChannelName("conv-abc")).toBe(
			"conversation:conv-abc",
		);
	});

	it("does not mutate the supplied id", async () => {
		const mod = await import("../lib/realtime-emit");
		const id = "abc";
		mod.getConversationChannelName(id);
		expect(id).toBe("abc");
	});
});

describe("emitConversationMessageAppended", () => {
	it("emits message_appended on the conversation channel when realtime is configured", async () => {
		const emitMock = vi.fn().mockResolvedValue(undefined);
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// Vitest 4 constructs mock implementations with `new`, so the stub must
		// be a real (constructable) function — an arrow throws "not a
		// constructor". `new Realtime()` returns the stub object.
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});
		const RedisMock = vi.fn();

		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: RedisMock }));

		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../lib/realtime-emit");
		await mod.emitConversationMessageAppended({
			conversationId: "conv-1",
			messageId: "msg-1",
			appendedAt: "2026-05-27T10:00:00.000Z",
		});

		expect(channelMock).toHaveBeenCalledWith("conversation:conv-1");
		expect(emitMock).toHaveBeenCalledTimes(1);
		expect(emitMock).toHaveBeenCalledWith("message_appended", {
			conversationId: "conv-1",
			messageId: "msg-1",
			appendedAt: "2026-05-27T10:00:00.000Z",
		});
	});

	it("is a no-op when Upstash env vars are absent (realtime not configured)", async () => {
		const emitMock = vi.fn();
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// Vitest 4 constructs mock implementations with `new`, so the stub must
		// be a real (constructable) function — an arrow throws "not a
		// constructor". `new Realtime()` returns the stub object.
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});

		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn() }));

		process.env.UPSTASH_REDIS_REST_URL = undefined;
		process.env.UPSTASH_REDIS_REST_TOKEN = undefined;

		const mod = await import("../lib/realtime-emit");

		await expect(
			mod.emitConversationMessageAppended({
				conversationId: "conv-2",
				messageId: "msg-2",
				appendedAt: "2026-05-27T10:00:01.000Z",
			}),
		).resolves.toBeUndefined();

		// Crucially: no client construction, no channel call, no emit.
		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("swallows errors thrown by channel.emit (Redis outage must not crash callers)", async () => {
		const emitMock = vi.fn().mockRejectedValue(new Error("Redis down"));
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// Vitest 4 constructs mock implementations with `new`, so the stub must
		// be a real (constructable) function — an arrow throws "not a
		// constructor". `new Realtime()` returns the stub object.
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});

		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn() }));

		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../lib/realtime-emit");

		await expect(
			mod.emitConversationMessageAppended({
				conversationId: "conv-3",
				messageId: "msg-3",
				appendedAt: "2026-05-27T10:00:02.000Z",
			}),
		).resolves.toBeUndefined();

		expect(emitMock).toHaveBeenCalledTimes(1);
	});

	it("memoises the Realtime client across multiple emits in the same process", async () => {
		const emitMock = vi.fn().mockResolvedValue(undefined);
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// Vitest 4 constructs mock implementations with `new`, so the stub must
		// be a real (constructable) function — an arrow throws "not a
		// constructor". `new Realtime()` returns the stub object.
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});
		const RedisMock = vi.fn();

		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: RedisMock }));

		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../lib/realtime-emit");

		const payload = {
			conversationId: "conv-4",
			messageId: "msg-4",
			appendedAt: "2026-05-27T10:00:03.000Z",
		};
		await mod.emitConversationMessageAppended(payload);
		await mod.emitConversationMessageAppended(payload);

		// Two emits, but only one Realtime construction + one Redis
		// construction (lazy + memoised).
		expect(RealtimeMock).toHaveBeenCalledTimes(1);
		expect(RedisMock).toHaveBeenCalledTimes(1);
		expect(emitMock).toHaveBeenCalledTimes(2);
	});
});

/**
 * The project-channel events a Temporal activity publishes as well as the
 * API (`publishSyncedContextDeleted`, Fizzy #2636): moved here from
 * `packages/api/lib/realtime.ts`, which re-exports them, so both publish on
 * the same channel with the same payload schema.
 */
describe("emitContextChange / emitActivity", () => {
	function realtimeWith(emitMock: ReturnType<typeof vi.fn>) {
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn() }));
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
		return { channelMock, RealtimeMock };
	}

	const contextChange = {
		projectId: "proj-1",
		contextId: "ctx-1",
		action: "deleted" as const,
		userId: "user-1",
		userName: "Example Dev",
		contextType: "TEXT",
		contextName: "glossary.md",
	};

	const activity = {
		projectId: "proj-1",
		userId: "user-1",
		userName: "Example Dev",
		activityType: "context_deleted",
		resourceType: "context",
		resourceId: "ctx-1",
		resourceName: "glossary.md",
		timestamp: "2026-09-22T12:00:00.000Z",
	};

	it("names the project channel as the API's subscriber does", async () => {
		const mod = await import("../lib/realtime-emit");
		expect(mod.getProjectChannelName("proj-1")).toBe("project:proj-1");
	});

	it("emits context_change and activity on the project's channel", async () => {
		const emitMock = vi.fn().mockResolvedValue(undefined);
		const { channelMock } = realtimeWith(emitMock);

		const mod = await import("../lib/realtime-emit");
		await mod.emitContextChange(contextChange);
		await mod.emitActivity(activity);

		expect(channelMock).toHaveBeenCalledWith("project:proj-1");
		expect(emitMock).toHaveBeenNthCalledWith(
			1,
			"context_change",
			contextChange,
		);
		expect(emitMock).toHaveBeenNthCalledWith(2, "activity", activity);
	});

	it("never throws: a Redis outage degrades to the next refresh", async () => {
		const emitMock = vi.fn().mockRejectedValue(new Error("Redis down"));
		realtimeWith(emitMock);

		const mod = await import("../lib/realtime-emit");

		await expect(mod.emitContextChange(contextChange)).resolves.toBe(
			undefined,
		);
		await expect(mod.emitActivity(activity)).resolves.toBeUndefined();
		expect(emitMock).toHaveBeenCalledTimes(2);
	});

	it("is a no-op when realtime is not configured", async () => {
		const emitMock = vi.fn();
		const { RealtimeMock } = realtimeWith(emitMock);
		process.env.UPSTASH_REDIS_REST_URL = undefined;
		process.env.UPSTASH_REDIS_REST_TOKEN = undefined;

		const mod = await import("../lib/realtime-emit");
		await mod.emitContextChange(contextChange);
		await mod.emitActivity(activity);

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("emits through a client the caller passes, building none of its own", async () => {
		const ownEmit = vi.fn();
		const { RealtimeMock } = realtimeWith(ownEmit);
		const callerEmit = vi.fn().mockResolvedValue(undefined);
		const channel = vi.fn(() => ({ emit: callerEmit }));

		const mod = await import("../lib/realtime-emit");
		await mod.emitContextChange(contextChange, { channel });
		await mod.emitActivity(activity, { channel });

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(ownEmit).not.toHaveBeenCalled();
		expect(channel).toHaveBeenCalledWith("project:proj-1");
		expect(callerEmit).toHaveBeenNthCalledWith(
			1,
			"context_change",
			contextChange,
		);
		expect(callerEmit).toHaveBeenNthCalledWith(2, "activity", activity);
	});

	it("emits nothing when the caller passes no client, and does not fall back to its own", async () => {
		const ownEmit = vi.fn();
		const { RealtimeMock } = realtimeWith(ownEmit);

		const mod = await import("../lib/realtime-emit");
		await mod.emitContextChange(contextChange, null);
		await mod.emitActivity(activity, null);

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(ownEmit).not.toHaveBeenCalled();
	});
});

/**
 * `document_change`, which Proposal generation publishes from the worker as
 * its sections land (Fizzy #2801): moved here from
 * `packages/api/lib/realtime.ts` like `context_change`, so the worker and the
 * API publish the same payload on the same channel.
 */
describe("emitDocumentChange", () => {
	function realtimeWith(emitMock: ReturnType<typeof vi.fn>) {
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn() }));
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
		return { channelMock, RealtimeMock };
	}

	const documentChange = {
		projectId: "proj-1",
		documentId: "doc-1",
		action: "updated" as const,
		userId: "user-1",
		userName: "Fabric",
	};

	it("emits document_change on the project's channel", async () => {
		const emitMock = vi.fn().mockResolvedValue(undefined);
		const { channelMock } = realtimeWith(emitMock);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);

		expect(channelMock).toHaveBeenCalledWith("project:proj-1");
		expect(emitMock).toHaveBeenCalledTimes(1);
		expect(emitMock).toHaveBeenCalledWith(
			"document_change",
			documentChange,
		);
	});

	it("is a no-op that never throws when the Upstash env is absent", async () => {
		const emitMock = vi.fn();
		const { RealtimeMock } = realtimeWith(emitMock);
		process.env.UPSTASH_REDIS_REST_URL = undefined;
		process.env.UPSTASH_REDIS_REST_TOKEN = undefined;

		const mod = await import("../lib/realtime-emit");

		await expect(
			mod.emitDocumentChange(documentChange),
		).resolves.toBeUndefined();
		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("never throws: a Redis outage degrades to the next refresh", async () => {
		const emitMock = vi.fn().mockRejectedValue(new Error("Redis down"));
		realtimeWith(emitMock);

		const mod = await import("../lib/realtime-emit");

		await expect(
			mod.emitDocumentChange(documentChange),
		).resolves.toBeUndefined();
		expect(emitMock).toHaveBeenCalledTimes(1);
	});

	it("emits through a client the caller passes, and nothing for null", async () => {
		const ownEmit = vi.fn();
		const { RealtimeMock } = realtimeWith(ownEmit);
		const callerEmit = vi.fn().mockResolvedValue(undefined);
		const channel = vi.fn(() => ({ emit: callerEmit }));

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange, { channel });
		await mod.emitDocumentChange(documentChange, null);

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(ownEmit).not.toHaveBeenCalled();
		expect(channel).toHaveBeenCalledTimes(1);
		expect(callerEmit).toHaveBeenCalledWith(
			"document_change",
			documentChange,
		);
	});

	it("registers its schema on its own client, and the schema accepts what the web client reads", async () => {
		const { RealtimeMock } = realtimeWith(vi.fn());

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);

		expect(RealtimeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				schema: expect.objectContaining({
					document_change: mod.documentChangeSchema,
				}),
			}),
		);
		expect(mod.documentChangeSchema.parse(documentChange)).toEqual(
			documentChange,
		);
		expect(
			mod.documentChangeSchema.safeParse({
				...documentChange,
				action: "generating",
			}).success,
		).toBe(false);
	});
});

/**
 * The fallback for a process without Upstash (the Azure workers, Fizzy
 * #2946): each emit is POSTed to the web's `/api/internal/realtime-emit` with
 * the service secret, and the web publishes it with its own client.
 */
describe("relay through the web app", () => {
	const SECRET = "synthetic-relay-secret";

	const documentChange = {
		projectId: "proj-1",
		documentId: "doc-1",
		action: "updated" as const,
		userId: "user-1",
		userName: "Example Dev",
	};

	const messageAppended = {
		conversationId: "conv-1",
		messageId: "msg-1",
		appendedAt: "2026-10-23T10:00:00.000Z",
	};

	const contextChange = {
		projectId: "proj-1",
		contextId: "ctx-1",
		action: "deleted" as const,
		userId: "user-1",
		userName: "Example Dev",
	};

	const activity = {
		projectId: "proj-1",
		userId: "user-1",
		userName: "Example Dev",
		activityType: "context_deleted",
		timestamp: "2026-10-23T10:00:00.000Z",
	};

	function upstashMock() {
		const emitMock = vi.fn().mockResolvedValue(undefined);
		const channelMock = vi.fn(() => ({ emit: emitMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: channelMock };
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn() }));
		return { emitMock, channelMock, RealtimeMock };
	}

	function relayEnv() {
		process.env.UPSTASH_REDIS_REST_URL = undefined;
		process.env.UPSTASH_REDIS_REST_TOKEN = undefined;
		process.env.AGENT_SERVICE_SECRET = SECRET;
		process.env.APP_URL = "https://app.example.com/";
	}

	function fetchReturning(response: () => Promise<Response>) {
		const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
			response(),
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	function sentBody(call: [string, RequestInit]) {
		return JSON.parse(String(call[1].body));
	}

	it("POSTs one emit to the relay with the service secret and the event", async () => {
		const { RealtimeMock } = upstashMock();
		relayEnv();
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://app.example.com/api/internal/realtime-emit");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"Content-Type": "application/json",
			"X-Agent-Service-Token": SECRET,
		});
		const body = sentBody(fetchMock.mock.calls[0]);
		expect(body).toEqual({
			channel: "project",
			id: "proj-1",
			event: "document_change",
			data: documentChange,
		});
		// What the emitter sends is exactly what the route accepts.
		expect(mod.realtimeRelayRequestSchema.safeParse(body).success).toBe(
			true,
		);
	});

	it("relays every worker event on its own channel", async () => {
		upstashMock();
		relayEnv();
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitConversationMessageAppended(messageAppended);
		await mod.emitContextChange(contextChange);
		await mod.emitActivity(activity);

		const bodies = fetchMock.mock.calls.map(sentBody);
		expect(bodies).toEqual([
			{
				channel: "conversation",
				id: "conv-1",
				event: "message_appended",
				data: messageAppended,
			},
			{
				channel: "project",
				id: "proj-1",
				event: "context_change",
				data: contextChange,
			},
			{
				channel: "project",
				id: "proj-1",
				event: "activity",
				data: activity,
			},
		]);
		for (const body of bodies) {
			expect(mod.realtimeRelayRequestSchema.safeParse(body).success).toBe(
				true,
			);
		}
	});

	it("prefers FABRIC_INTERNAL_URL over APP_URL, as the coding-run bridge does", async () => {
		upstashMock();
		relayEnv();
		process.env.FABRIC_INTERNAL_URL = "https://internal.example.com";
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://internal.example.com/api/internal/realtime-emit",
		);
	});

	/** Silences and records every console level a relay failure may use. */
	function consoleSpies() {
		return {
			warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
			debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
			error: vi.spyOn(console, "error").mockImplementation(() => {}),
		};
	}

	it("never throws on a refusal, and logs neither the secret nor the payload", async () => {
		upstashMock();
		relayEnv();
		const spies = consoleSpies();
		fetchReturning(async () => new Response(null, { status: 503 }));

		const mod = await import("../lib/realtime-emit");
		await expect(
			mod.emitDocumentChange(documentChange),
		).resolves.toBeUndefined();

		expect(spies.warn).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify([
			spies.warn.mock.calls,
			spies.debug.mock.calls,
			spies.error.mock.calls,
		]);
		expect(logged).toContain("503");
		expect(logged).not.toContain(SECRET);
		expect(logged).not.toContain("doc-1");
		expect(logged).not.toContain("Example Dev");
	});

	it("warns once per kind of failure and logs repeats at debug", async () => {
		upstashMock();
		relayEnv();
		const spies = consoleSpies();
		const answers = [
			async () => new Response(null, { status: 503 }),
			async () => new Response(null, { status: 503 }),
			async () => new Response(null, { status: 500 }),
			async () => {
				throw new TypeError("fetch failed");
			},
			async () => {
				throw new TypeError("fetch failed");
			},
		];
		fetchReturning(() => (answers.shift() as () => Promise<Response>)());

		const mod = await import("../lib/realtime-emit");
		for (let emit = 0; emit < 5; emit++) {
			await mod.emitDocumentChange(documentChange);
		}

		// The first 503, the first 500 and the first network error.
		expect(spies.warn).toHaveBeenCalledTimes(3);
		expect(spies.debug).toHaveBeenCalledTimes(2);
		expect(spies.error).not.toHaveBeenCalled();
	});

	it("picks the channel from the event, not from the payload's fields", async () => {
		upstashMock();
		relayEnv();
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);
		const withConversationId = {
			...documentChange,
			conversationId: "conv-9",
		};

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(withConversationId);

		expect(sentBody(fetchMock.mock.calls[0])).toMatchObject({
			channel: "project",
			id: "proj-1",
			event: "document_change",
		});
	});

	it("never throws on a network error", async () => {
		upstashMock();
		relayEnv();
		consoleSpies();
		const fetchMock = fetchReturning(async () => {
			throw new TypeError("fetch failed");
		});

		const mod = await import("../lib/realtime-emit");
		await expect(
			mod.emitConversationMessageAppended(messageAppended),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("gives up after a short timeout instead of holding the activity", async () => {
		vi.useFakeTimers();
		upstashMock();
		relayEnv();
		consoleSpies();
		const fetchMock = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const mod = await import("../lib/realtime-emit");
		const pending = mod.emitDocumentChange(documentChange);
		await vi.advanceTimersByTimeAsync(2_000);
		const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
		expect(signal.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toBeUndefined();
		expect(signal.aborted).toBe(true);
	});

	it("publishes directly and does not relay when Upstash is configured", async () => {
		const { emitMock, channelMock } = upstashMock();
		relayEnv();
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);
		await mod.emitConversationMessageAppended(messageAppended);

		expect(channelMock).toHaveBeenNthCalledWith(1, "project:proj-1");
		expect(channelMock).toHaveBeenNthCalledWith(2, "conversation:conv-1");
		expect(emitMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does nothing with neither Upstash nor the relay configured", async () => {
		const { RealtimeMock } = upstashMock();
		process.env.UPSTASH_REDIS_REST_URL = undefined;
		process.env.UPSTASH_REDIS_REST_TOKEN = undefined;
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);
		await mod.emitConversationMessageAppended(messageAppended);

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not relay with only the secret or only a base URL", async () => {
		upstashMock();
		relayEnv();
		process.env.APP_URL = undefined;
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange);
		process.env.APP_URL = "https://app.example.com";
		process.env.AGENT_SERVICE_SECRET = undefined;
		await mod.emitDocumentChange(documentChange);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not relay for a caller that hands in no client", async () => {
		upstashMock();
		relayEnv();
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);

		const mod = await import("../lib/realtime-emit");
		await mod.emitDocumentChange(documentChange, null);
		await mod.emitContextChange(contextChange, null);
		await mod.emitActivity(activity, null);
		await mod.emitConversationMessageAppended(messageAppended, null);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("emits message_appended through a client the caller passes", async () => {
		const { RealtimeMock } = upstashMock();
		relayEnv();
		const fetchMock = fetchReturning(async () =>
			Response.json({ ok: true }),
		);
		const callerEmit = vi.fn().mockResolvedValue(undefined);
		const channel = vi.fn(() => ({ emit: callerEmit }));

		const mod = await import("../lib/realtime-emit");
		await mod.emitConversationMessageAppended(messageAppended, { channel });

		expect(RealtimeMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(channel).toHaveBeenCalledWith("conversation:conv-1");
		expect(callerEmit).toHaveBeenCalledWith(
			"message_appended",
			messageAppended,
		);
	});
});
