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
		expect(k.startsWith("transcript:v7:user-1:")).toBe(true);
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

it("scopes summary cache keys by content, organization and project", () => {
	const key = CacheKeys.meetingTranscriptSummary(
		"transcript",
		"example-org",
		"example-project",
		4_096,
	);
	expect(
		CacheKeys.meetingTranscriptSummary(
			"transcript",
			"example-org",
			"example-project",
			4_096,
		),
	).toBe(key);
	expect(
		CacheKeys.meetingTranscriptSummary(
			"changed",
			"example-org",
			"example-project",
			4_096,
		),
	).not.toBe(key);
	expect(
		CacheKeys.meetingTranscriptSummary(
			"transcript",
			"another-org",
			"example-project",
			4_096,
		),
	).not.toBe(key);
	expect(
		CacheKeys.meetingTranscriptSummary(
			"transcript",
			"example-org",
			"another-project",
			4_096,
		),
	).not.toBe(key);
	expect(key).not.toContain("transcript:");
});

it("versions extraction summaries and buckets nearby target sizes", () => {
	const key = (targetChars: number) =>
		CacheKeys.meetingTranscriptSummary(
			"example transcript",
			"example-org",
			"example-project",
			targetChars,
		);
	expect(key(4_001)).toMatch(/^transcript-summary:v4:/);
	expect(key(4_001)).toBe(key(4_050));
	expect(key(4_001)).not.toBe(key(5_000));
});

it("shares a geometric summary bucket across targets hundreds of characters apart", () => {
	const key = (target: number) =>
		CacheKeys.meetingTranscriptSummary(
			"example transcript",
			"example-org",
			"example-project",
			target,
		);
	expect(key(5_000)).toBe(key(5_500));
	expect(key(5_000)).not.toBe(key(6_500));
});
