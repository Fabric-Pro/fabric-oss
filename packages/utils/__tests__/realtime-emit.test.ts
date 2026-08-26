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
