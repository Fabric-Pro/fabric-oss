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

beforeEach(() => {
	vi.resetModules();
	process.env = { ...originalEnv };
});

afterEach(() => {
	process.env = originalEnv;
	vi.resetModules();
	vi.restoreAllMocks();
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
