/**
 * Realtime SSE stream duration budget (issue #2254).
 *
 * `@upstash/realtime` gracefully closes each SSE stream at
 * `maxDurationSecs - 2s`, measured from inside its `handle()` — a clock
 * that excludes cold start and routing time. The library default
 * (`maxDurationSecs = 300`) equals the Vercel function limit, so the
 * graceful close races the platform's hard 300s kill and can lose,
 * surfacing as "Task timed out after 300 seconds". Passing an explicit,
 * lower `maxDurationSecs` gives the graceful close real headroom before
 * the platform kill.
 *
 * Test surface:
 *   - `REALTIME_STREAM_MAX_DURATION_SECS` is 270 and stays meaningfully
 *     below the 300s platform limit (drift guard).
 *   - `getProjectRealtime()` passes `maxDurationSecs:
 *     REALTIME_STREAM_MAX_DURATION_SECS` through to the `Realtime`
 *     constructor.
 *
 * NOTE: mocking `@upstash/realtime`/`@upstash/redis` must happen from a
 * test file that lives (and resolves those specifiers) inside
 * `packages/api` itself — pnpm hoists two physically distinct copies of
 * each package (different peer `zod` versions, see the type-assertion
 * comments in the realtime route files), so an `apps/web` test's
 * `vi.doMock` patches a different resolved module than the one
 * `lib/realtime.ts` actually imports and silently fails to intercept it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
	vi.resetModules();
	process.env = { ...originalEnv };
});

afterEach(() => {
	process.env = originalEnv;
	vi.resetModules();
	vi.restoreAllMocks();
});

describe("REALTIME_STREAM_MAX_DURATION_SECS", () => {
	it("is 270 seconds", async () => {
		const mod = await import("../realtime");
		expect(mod.REALTIME_STREAM_MAX_DURATION_SECS).toBe(270);
	});

	it("stays meaningfully below the 300s Vercel platform limit", async () => {
		const mod = await import("../realtime");
		expect(mod.REALTIME_STREAM_MAX_DURATION_SECS).toBeLessThanOrEqual(280);
	});
});

describe("getProjectRealtime", () => {
	it("passes maxDurationSecs through to the Realtime constructor", async () => {
		// Vitest 4 constructs mock implementations with `new`, so the stub must
		// be a real (constructable) function — an arrow throws "not a
		// constructor". `new Realtime()` returns the stub object.
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: vi.fn() };
		});
		const RedisMock = vi.fn();

		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		vi.doMock("@upstash/redis", () => ({ Redis: RedisMock }));

		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../realtime");
		mod.getProjectRealtime();

		expect(RealtimeMock).toHaveBeenCalledTimes(1);
		expect(RealtimeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				maxDurationSecs: mod.REALTIME_STREAM_MAX_DURATION_SECS,
			}),
		);
	});
});

describe("document_change schema", () => {
	it("subscribes with the same zod object the worker's emitter uses, so the SSE side accepts the lifted event", async () => {
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel: vi.fn() };
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Redis()`
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn(function () {}) }));
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../realtime");
		const shared = await import("@repo/utils/realtime-emit");
		mod.getProjectRealtime();

		const schema = (
			RealtimeMock.mock.calls[0] as unknown as [
				{ schema: Record<string, unknown> },
			]
		)[0].schema;
		expect(schema.document_change).toBe(shared.documentChangeSchema);
		expect(
			shared.documentChangeSchema.safeParse({
				projectId: "project-1",
				documentId: "doc-1",
				action: "updated",
				userId: "user-1",
				userName: "Fabric",
			}).success,
		).toBe(true);
	});
});

describe("one Realtime client for every API emit", () => {
	it("sends an API caller's document_change, activity and context_change through the same Realtime instance", async () => {
		const emits: Array<{ client: number; channel: string; event: string }> =
			[];
		let constructed = 0;
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			const client = ++constructed;
			return {
				channel: (channel: string) => ({
					emit: async (event: string) => {
						emits.push({ client, channel, event });
					},
				}),
			};
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Redis()`
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn(function () {}) }));
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../realtime");
		await mod.emitDocumentChange({
			projectId: "project-1",
			documentId: "doc-1",
			action: "updated",
			userId: "user-1",
			userName: "Example Dev",
		});
		await mod.emitActivity({
			projectId: "project-1",
			userId: "user-1",
			userName: "Example Dev",
			activityType: "document_updated",
			timestamp: "2026-09-22T11:00:00.000Z",
		});
		await mod.emitContextChange({
			projectId: "project-1",
			contextId: "ctx-1",
			action: "deleted",
			userId: "user-1",
			userName: "Example Dev",
		});

		// One client, the API's, for all three events.
		expect(RealtimeMock).toHaveBeenCalledTimes(1);
		expect(RealtimeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				maxDurationSecs: mod.REALTIME_STREAM_MAX_DURATION_SECS,
			}),
		);
		expect(emits).toEqual([
			{
				client: 1,
				channel: "project:project-1",
				event: "document_change",
			},
			{ client: 1, channel: "project:project-1", event: "activity" },
			{
				client: 1,
				channel: "project:project-1",
				event: "context_change",
			},
		]);
	});

	it("emits nothing, and builds no second client, when the API's Realtime is not configured", async () => {
		const RealtimeMock = vi.fn();
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;

		const mod = await import("../realtime");
		await mod.emitActivity({
			projectId: "project-1",
			userId: "user-1",
			userName: "Example Dev",
			activityType: "document_updated",
			timestamp: "2026-09-22T11:00:00.000Z",
		});

		expect(RealtimeMock).not.toHaveBeenCalled();
	});
});

/**
 * `message_appended` from an API caller (`record-operation-result`) goes out
 * on the API's client like the project events, and never through the worker
 * relay (Fizzy #2946): a web process without Upstash must not POST it to
 * itself, or to whatever app URL it was given.
 */
describe("emitConversationMessageAppended (API)", () => {
	const messageAppended = {
		conversationId: "conv-1",
		messageId: "msg-1",
		appendedAt: "2026-10-23T10:00:00.000Z",
	};

	it("publishes on the API's client, on the conversation's channel", async () => {
		const emits: Array<{ channel: string; event: string }> = [];
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return {
				channel: (channel: string) => ({
					emit: async (event: string) => {
						emits.push({ channel, event });
					},
				}),
			};
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Redis()`
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn(function () {}) }));
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

		const mod = await import("../realtime");
		await mod.emitConversationMessageAppended(messageAppended);

		expect(RealtimeMock).toHaveBeenCalledTimes(1);
		expect(RealtimeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				maxDurationSecs: mod.REALTIME_STREAM_MAX_DURATION_SECS,
			}),
		);
		expect(emits).toEqual([
			{ channel: "conversation:conv-1", event: "message_appended" },
		]);
	});

	it("never relays: without Upstash it emits nothing, even with the relay env set", async () => {
		const RealtimeMock = vi.fn();
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
		process.env.AGENT_SERVICE_SECRET = "synthetic-relay-secret";
		process.env.NEXT_PUBLIC_APP_URL = "https://staging.example.com";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		try {
			const mod = await import("../realtime");
			await expect(
				mod.emitConversationMessageAppended(messageAppended),
			).resolves.toBeUndefined();

			expect(RealtimeMock).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

/**
 * The web half of the worker relay (Fizzy #2946): the route at
 * `/api/internal/realtime-emit` hands a validated event here, and it goes out
 * on the API's client, on the channel the SSE routes subscribe to.
 */
describe("publishRelayedEvent", () => {
	function apiRealtime(emit = vi.fn().mockResolvedValue(undefined)) {
		const channel = vi.fn(() => ({ emit }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Realtime()`
		const RealtimeMock = vi.fn(function () {
			return { channel };
		});
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Redis()`
		vi.doMock("@upstash/redis", () => ({ Redis: vi.fn(function () {}) }));
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
		return { channel, emit, RealtimeMock };
	}

	const documentChange = {
		projectId: "project-1",
		documentId: "doc-1",
		action: "updated" as const,
		userId: "user-1",
		userName: "Example Dev",
	};

	it("publishes a project event on the project's channel with the API's client", async () => {
		const { channel, emit, RealtimeMock } = apiRealtime();

		const mod = await import("../realtime");
		await expect(
			mod.publishRelayedEvent({
				channel: "project",
				id: "project-1",
				event: "document_change",
				data: documentChange,
			}),
		).resolves.toBe(true);

		expect(RealtimeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				maxDurationSecs: mod.REALTIME_STREAM_MAX_DURATION_SECS,
			}),
		);
		expect(channel).toHaveBeenCalledWith("project:project-1");
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith("document_change", documentChange);
	});

	it("publishes message_appended on the conversation's channel", async () => {
		const { channel, emit } = apiRealtime();
		const data = {
			conversationId: "conv-1",
			messageId: "msg-1",
			appendedAt: "2026-10-23T10:00:00.000Z",
		};

		const mod = await import("../realtime");
		await mod.publishRelayedEvent({
			channel: "conversation",
			id: "conv-1",
			event: "message_appended",
			data,
		});

		expect(channel).toHaveBeenCalledWith("conversation:conv-1");
		expect(emit).toHaveBeenCalledWith("message_appended", data);
	});

	it("answers false, and relays nothing on, when realtime is not configured here", async () => {
		const RealtimeMock = vi.fn();
		vi.doMock("@upstash/realtime", () => ({ Realtime: RealtimeMock }));
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
		process.env.AGENT_SERVICE_SECRET = "synthetic-relay-secret";
		process.env.APP_URL = "https://app.example.com";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		try {
			const mod = await import("../realtime");
			await expect(
				mod.publishRelayedEvent({
					channel: "project",
					id: "project-1",
					event: "document_change",
					data: documentChange,
				}),
			).resolves.toBe(false);

			expect(RealtimeMock).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("lets a failed publish throw, so the route can answer with an error", async () => {
		apiRealtime(vi.fn().mockRejectedValue(new Error("Redis down")));

		const mod = await import("../realtime");
		await expect(
			mod.publishRelayedEvent({
				channel: "project",
				id: "project-1",
				event: "document_change",
				data: documentChange,
			}),
		).rejects.toThrow("Redis down");
	});
});
