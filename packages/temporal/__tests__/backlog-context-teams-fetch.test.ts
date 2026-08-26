import { describe, expect, it } from "vitest";
import { filterMessagesByDaysBack } from "../src/activities/search-project-teams-messages";

describe("filterMessagesByDaysBack", () => {
	const now = new Date("2026-04-23T12:00:00.000Z");
	const msgs = [
		{ createdAt: "2026-04-22T12:00:00.000Z" }, // 1 day ago
		{ createdAt: "2026-04-10T12:00:00.000Z" }, // 13 days ago
		{ createdAt: "2026-03-20T12:00:00.000Z" }, // 34 days ago
		{ createdAt: undefined }, // no timestamp
	];

	it("returns all messages when daysBack is undefined", () => {
		expect(filterMessagesByDaysBack(msgs, undefined, now)).toHaveLength(4);
	});

	it("keeps only messages newer than the cutoff", () => {
		const result = filterMessagesByDaysBack(msgs, 14, now);
		expect(result).toHaveLength(2);
		expect(result.map((m) => m.createdAt)).toEqual([
			"2026-04-22T12:00:00.000Z",
			"2026-04-10T12:00:00.000Z",
		]);
	});

	it("drops messages with no createdAt when daysBack is set", () => {
		const result = filterMessagesByDaysBack(msgs, 30, now);
		expect(result.every((m) => !!m.createdAt)).toBe(true);
	});

	it("returns empty array when daysBack window covers nothing", () => {
		expect(filterMessagesByDaysBack(msgs, 0, now)).toHaveLength(0);
	});
});
