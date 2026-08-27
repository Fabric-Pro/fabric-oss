/**
 * Pure-helper tests for the User Activity dashboard query layer: UTC day
 * bucketing and last-login sorting.
 */
import { describe, expect, it } from "vitest";
import {
	activityRangeStart,
	bucketLoginsByDay,
	sortMembersByRecency,
} from "../prisma/queries/user-activity";

const NOW = new Date("2026-07-02T15:30:00.000Z");

describe("bucketLoginsByDay", () => {
	it("returns one zero-count bucket per day when there are no logins", () => {
		const buckets = bucketLoginsByDay([], 7, NOW);
		expect(buckets).toHaveLength(7);
		expect(buckets[0]).toEqual({ day: "2026-06-26", count: 0 });
		expect(buckets[6]).toEqual({ day: "2026-07-02", count: 0 });
		expect(buckets.every((b) => b.count === 0)).toBe(true);
	});

	it("counts logins into their UTC day", () => {
		const buckets = bucketLoginsByDay(
			[
				new Date("2026-07-01T00:00:01.000Z"),
				new Date("2026-07-01T23:59:59.000Z"),
				new Date("2026-07-02T10:00:00.000Z"),
			],
			7,
			NOW,
		);
		expect(buckets.find((b) => b.day === "2026-07-01")?.count).toBe(2);
		expect(buckets.find((b) => b.day === "2026-07-02")?.count).toBe(1);
	});

	it("ignores logins outside the range window", () => {
		const buckets = bucketLoginsByDay(
			[new Date("2026-06-01T12:00:00.000Z")],
			7,
			NOW,
		);
		expect(buckets.every((b) => b.count === 0)).toBe(true);
	});

	it("covers 90 days oldest-first", () => {
		const buckets = bucketLoginsByDay([], 90, NOW);
		expect(buckets).toHaveLength(90);
		expect(buckets[0].day < buckets[89].day).toBe(true);
		expect(buckets[89].day).toBe("2026-07-02");
	});
});

describe("activityRangeStart", () => {
	it("returns UTC midnight of the oldest bucket day", () => {
		expect(activityRangeStart(7, NOW)).toEqual(
			new Date("2026-06-26T00:00:00.000Z"),
		);
	});

	it("matches the first bucket produced by bucketLoginsByDay", () => {
		const start = activityRangeStart(90, NOW);
		const buckets = bucketLoginsByDay([], 90, NOW);
		expect(start.toISOString().slice(0, 10)).toBe(buckets[0].day);
	});
});

describe("sortMembersByRecency", () => {
	const rows = [
		{
			email: "b@example.com",
			lastSeenAt: new Date("2026-07-01T00:00:00Z"),
		},
		{ email: "a@example.com", lastSeenAt: null },
		{
			email: "c@example.com",
			lastSeenAt: new Date("2026-06-01T00:00:00Z"),
		},
	];
	const bySeen = (r: { lastSeenAt: Date | null }) => r.lastSeenAt;

	it("desc puts most recently active first and never-active last", () => {
		const sorted = sortMembersByRecency(rows, "desc", bySeen);
		expect(sorted.map((r) => r.email)).toEqual([
			"b@example.com",
			"c@example.com",
			"a@example.com",
		]);
	});

	it("asc puts never-active first (most inactive), then oldest", () => {
		const sorted = sortMembersByRecency(rows, "asc", bySeen);
		expect(sorted.map((r) => r.email)).toEqual([
			"a@example.com",
			"c@example.com",
			"b@example.com",
		]);
	});

	it("does not mutate the input array", () => {
		const copy = [...rows];
		sortMembersByRecency(rows, "desc", bySeen);
		expect(rows).toEqual(copy);
	});

	it("breaks ties by email ascending", () => {
		const tied = [
			{ email: "z@example.com", lastSeenAt: null },
			{ email: "a@example.com", lastSeenAt: null },
		];
		expect(
			sortMembersByRecency(tied, "desc", bySeen).map((r) => r.email),
		).toEqual(["a@example.com", "z@example.com"]);
	});

	it("sorts on whichever date the accessor returns", () => {
		const mixed = [
			{
				email: "b@example.com",
				lastSeenAt: null,
				lastLoginAt: new Date("2026-07-01T00:00:00Z"),
			},
			{
				email: "a@example.com",
				lastSeenAt: new Date("2026-07-20T00:00:00Z"),
				lastLoginAt: null,
			},
		];
		expect(
			sortMembersByRecency(mixed, "desc", (r) => r.lastLoginAt).map(
				(r) => r.email,
			),
		).toEqual(["b@example.com", "a@example.com"]);
	});
});
