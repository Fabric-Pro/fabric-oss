/**
 * Unit tests for the meeting-transcript cache key + TTL added for the
 * AI Update transcript-fetch performance work.
 *
 * The key must be PER-USER (the calendar belongs to the signed-in user) and
 * PER-INSTANCE (joinUrl + selected startTime) so recurring-meeting instances
 * never collide and a cache hit is always the right meeting.
 */

import { describe, expect, it, vi } from "vitest";

// Keep the import light — the key builders are pure and never touch Redis,
// but importing the module pulls in the (lazy) client + logger.
vi.mock("../redis-publisher", () => ({
	getRedisClient: vi.fn(async () => null),
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));

import { CacheKeys, CacheTTL } from "../redis-cache";

describe("CacheKeys.meetingTranscript", () => {
	it("is stable and user-scoped for identical inputs", () => {
		const k = CacheKeys.meetingTranscript(
			"user-1",
			"https://teams.microsoft.com/abc",
			"2026-06-11T10:00:00Z",
		);
		expect(k).toBe(
			CacheKeys.meetingTranscript(
				"user-1",
				"https://teams.microsoft.com/abc",
				"2026-06-11T10:00:00Z",
			),
		);
		expect(k.startsWith("transcript:user-1:")).toBe(true);
	});

	it("never collides across users (no cross-user leak)", () => {
		const a = CacheKeys.meetingTranscript(
			"user-1",
			"https://teams/abc",
			"t",
		);
		const b = CacheKeys.meetingTranscript(
			"user-2",
			"https://teams/abc",
			"t",
		);
		expect(a).not.toBe(b);
	});

	it("differs by meeting instance (joinUrl and startTime)", () => {
		const base = CacheKeys.meetingTranscript(
			"u",
			"https://teams/abc",
			"2026-06-11T10:00:00Z",
		);
		// Different joinUrl
		expect(base).not.toBe(
			CacheKeys.meetingTranscript(
				"u",
				"https://teams/def",
				"2026-06-11T10:00:00Z",
			),
		);
		// Different recurring instance (same joinUrl, different startTime)
		expect(base).not.toBe(
			CacheKeys.meetingTranscript(
				"u",
				"https://teams/abc",
				"2026-06-12T10:00:00Z",
			),
		);
	});

	it("uses a 'latest' segment when startTime is omitted", () => {
		expect(CacheKeys.meetingTranscript("u", "https://teams/abc")).toBe(
			CacheKeys.meetingTranscript("u", "https://teams/abc", undefined),
		);
		expect(
			CacheKeys.meetingTranscript("u", "https://teams/abc").endsWith(
				":latest",
			),
		).toBe(true);
	});

	it("caches transcripts for a long TTL since they are immutable", () => {
		expect(CacheTTL.meetingTranscript).toBe(7 * 24 * 60 * 60);
	});
});
