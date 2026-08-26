/**
 * Unit tests for the per-user AI Updates meetings cache.
 *
 * Pins the guarantees the meetings-dropdown performance fix relies on:
 *  - keys are scoped per user / org / daysBack (no cross-tenant leakage),
 *  - successful results are written with a 60s TTL,
 *  - a set→get roundtrip returns the same list, and
 *  - the module degrades to a no-op (callers go straight to Microsoft Graph)
 *    when Upstash Redis isn't configured — i.e. identical to today's behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { store, setSpy, getSpy } = vi.hoisted(() => ({
	store: new Map<string, unknown>(),
	setSpy: vi.fn(),
	getSpy: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
	// Vitest invokes mock implementations with `new`, so the stub must be a
	// real (constructable) function. `new Redis({url, token})` returns an
	// object whose get/set are backed by the shared in-memory `store`.
	// biome-ignore lint/complexity/useArrowFunction: must stay constructable for `new Redis()`
	Redis: vi.fn(function () {
		return {
			get: async (key: string) => {
				getSpy(key);
				return store.has(key) ? store.get(key) : null;
			},
			set: async (
				key: string,
				value: unknown,
				opts?: { ex?: number },
			) => {
				setSpy(key, value, opts);
				store.set(key, value);
				return "OK";
			},
		};
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

const SAMPLE = [
	{
		id: "m1",
		subject: "Daily Standup",
		startTime: "2026-06-11T10:00:00Z",
		organizer: "Alice Anderson",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
	},
];

beforeEach(() => {
	vi.resetModules();
	store.clear();
	setSpy.mockClear();
	getSpy.mockClear();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("meetings-cache — Redis configured", () => {
	beforeEach(() => {
		process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
		process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
	});

	it("set writes a per-user/org/daysBack key with a 60s TTL", async () => {
		const { setCachedMeetings } = await import("../meetings-cache");
		await setCachedMeetings("user-1", "org-1", 30, SAMPLE);
		expect(setSpy).toHaveBeenCalledWith(
			"backlog:meetings:user-1:org-1:30",
			SAMPLE,
			{ ex: 60 },
		);
	});

	it("get reads back exactly what set wrote (roundtrip)", async () => {
		const { getCachedMeetings, setCachedMeetings } = await import(
			"../meetings-cache"
		);
		await setCachedMeetings("user-1", "org-1", 30, SAMPLE);
		expect(await getCachedMeetings("user-1", "org-1", 30)).toEqual(SAMPLE);
	});

	it("uses '_' for a null organizationId (personal context) in the key", async () => {
		const { setCachedMeetings } = await import("../meetings-cache");
		await setCachedMeetings("user-1", null, 30, SAMPLE);
		expect(setSpy).toHaveBeenCalledWith(
			"backlog:meetings:user-1:_:30",
			SAMPLE,
			{ ex: 60 },
		);
	});

	it("isolates entries by user, org, and daysBack (no cross-tenant leak)", async () => {
		const { getCachedMeetings, setCachedMeetings } = await import(
			"../meetings-cache"
		);
		await setCachedMeetings("user-1", "org-1", 30, SAMPLE);
		expect(await getCachedMeetings("user-2", "org-1", 30)).toBeNull(); // other user
		expect(await getCachedMeetings("user-1", "org-2", 30)).toBeNull(); // other org
		expect(await getCachedMeetings("user-1", null, 30)).toBeNull(); // personal vs org
		expect(await getCachedMeetings("user-1", "org-1", 7)).toBeNull(); // other range
		expect(await getCachedMeetings("user-1", "org-1", 30)).toEqual(SAMPLE); // exact
	});

	it("returns null when the stored value is not an array (defensive)", async () => {
		const { getCachedMeetings } = await import("../meetings-cache");
		store.set("backlog:meetings:user-x:_:30", "corrupt-non-array");
		expect(await getCachedMeetings("user-x", null, 30)).toBeNull();
	});

	it("caches an empty (but valid) result list", async () => {
		const { getCachedMeetings, setCachedMeetings } = await import(
			"../meetings-cache"
		);
		await setCachedMeetings("user-1", "org-1", 30, []);
		expect(setSpy).toHaveBeenCalledWith(
			"backlog:meetings:user-1:org-1:30",
			[],
			{ ex: 60 },
		);
		expect(await getCachedMeetings("user-1", "org-1", 30)).toEqual([]);
	});
});

describe("meetings-cache — Redis NOT configured (graceful fallback)", () => {
	beforeEach(() => {
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
	});

	it("get returns null and set is a no-op — callers fall through to Graph", async () => {
		const { getCachedMeetings, setCachedMeetings } = await import(
			"../meetings-cache"
		);
		expect(await getCachedMeetings("user-1", "org-1", 30)).toBeNull();
		await expect(
			setCachedMeetings("user-1", "org-1", 30, SAMPLE),
		).resolves.toBeUndefined();
		expect(getSpy).not.toHaveBeenCalled();
		expect(setSpy).not.toHaveBeenCalled();
	});
});
