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
