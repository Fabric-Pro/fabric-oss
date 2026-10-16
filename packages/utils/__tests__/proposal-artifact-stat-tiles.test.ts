import { describe, expect, it } from "vitest";
import {
	parseStatTiles,
	STAT_TILES_LANGUAGE,
	STAT_TILES_LIMITS,
	STAT_TILES_RULE,
	type StatTilesParseResult,
} from "../lib/proposal-artifact/stat-tiles";

const lines = (...parts: string[]) => parts.join("\n");

const THREE_ITEMS = lines(
	"Faster onboarding: 40%",
	"Pilot sites: 3",
	"Annual savings: $1.2M",
);

const THREE_ITEMS_PARSED = [
	{ label: "Faster onboarding", value: "40%" },
	{ label: "Pilot sites", value: "3" },
	{ label: "Annual savings", value: "$1.2M" },
];

function reasonOf(result: StatTilesParseResult): string {
	if (result.ok) {
		throw new Error("expected the block to be refused");
	}
	return result.reason;
}

describe("parseStatTiles", () => {
	it("names the fence language", () => {
		expect(STAT_TILES_LANGUAGE).toBe("stat-tiles");
	});

	it("parses a three-item block", () => {
		expect(parseStatTiles(THREE_ITEMS)).toEqual({
			ok: true,
			visualId: null,
			items: THREE_ITEMS_PARSED,
		});
	});

	it("reads a leading fabric-visual marker as the visual id, not a tile", () => {
		const result = parseStatTiles(
			lines("%% fabric-visual: a1b2c3d4e5f6", THREE_ITEMS),
		);

		expect(result).toEqual({
			ok: true,
			visualId: "a1b2c3d4e5f6",
			items: THREE_ITEMS_PARSED,
		});
	});

	it("accepts the marker after leading blank lines, since it is still the first content", () => {
		const result = parseStatTiles(
			lines("", "  ", "%% fabric-visual: a1b2c3d4e5f6", "Pilot sites: 3"),
		);

		expect(result.ok && result.visualId).toBe("a1b2c3d4e5f6");
	});

	it("parses one tile and four tiles, the bounds of the rule", () => {
		expect(parseStatTiles("Pilot sites: 3").ok).toBe(true);
		const four = parseStatTiles(lines(THREE_ITEMS, "Teams trained: 12"));
		expect(four.ok && four.items).toHaveLength(4);
	});

	it("refuses a five-item block with the rule as the reason", () => {
		const result = parseStatTiles(
			lines(THREE_ITEMS, "Teams trained: 12", "Regions: 2"),
		);

		expect(result.ok).toBe(false);
		expect(reasonOf(result)).toContain(STAT_TILES_RULE);
	});

	it("does not count the marker toward the four-tile limit", () => {
		const result = parseStatTiles(
			lines(
				"%% fabric-visual: a1b2c3d4e5f6",
				THREE_ITEMS,
				"Teams trained: 12",
			),
		);

		expect(result.ok && result.items).toHaveLength(4);
	});

	it("refuses a block with no tiles", () => {
		expect(reasonOf(parseStatTiles(""))).toContain(STAT_TILES_RULE);
		expect(reasonOf(parseStatTiles("\n  \n"))).toContain(STAT_TILES_RULE);
		expect(
			reasonOf(parseStatTiles("%% fabric-visual: a1b2c3d4e5f6")),
		).toContain(STAT_TILES_RULE);
	});

	it("refuses a value longer than 24 characters and accepts exactly 24", () => {
		const exact = "x".repeat(STAT_TILES_LIMITS.maxValueLength);
		expect(parseStatTiles(`Savings: ${exact}`).ok).toBe(true);
		expect(parseStatTiles(`Savings: ${exact}y`).ok).toBe(false);
	});

	it("refuses a label longer than 80 characters and accepts exactly 80", () => {
		const exact = "l".repeat(STAT_TILES_LIMITS.maxLabelLength);
		expect(parseStatTiles(`${exact}: 40%`).ok).toBe(true);
		expect(parseStatTiles(`${exact}m: 40%`).ok).toBe(false);
	});

	it("counts characters, not UTF-16 units, toward the value limit", () => {
		const emoji = "🚀".repeat(STAT_TILES_LIMITS.maxValueLength);
		expect(parseStatTiles(`Launches: ${emoji}`).ok).toBe(true);
	});

	it("refuses a line without a colon and a space", () => {
		expect(
			parseStatTiles(lines("Pilot sites: 3", "Annual savings")).ok,
		).toBe(false);
		expect(parseStatTiles("Pilot sites:3").ok).toBe(false);
		expect(parseStatTiles("Pilot sites:").ok).toBe(false);
	});

	it("refuses an empty label or value", () => {
		expect(parseStatTiles(": 40%").ok).toBe(false);
		expect(parseStatTiles("Pilot sites:    ").ok).toBe(false);
	});

	it("splits at the first colon and space, so a value may hold a colon", () => {
		const result = parseStatTiles("Support ratio: 3:1");
		expect(result.ok && result.items).toEqual([
			{ label: "Support ratio", value: "3:1" },
		]);
		const spaced = parseStatTiles("Window: 9: 30 to 5");
		expect(spaced.ok && spaced.items).toEqual([
			{ label: "Window", value: "9: 30 to 5" },
		]);
	});

	it("trims both sides and ignores blank lines between tiles", () => {
		const result = parseStatTiles(
			lines("  Faster onboarding :   40%  ", "", "\tPilot sites: 3\t"),
		);

		expect(result.ok && result.items).toEqual([
			{ label: "Faster onboarding", value: "40%" },
			{ label: "Pilot sites", value: "3" },
		]);
	});

	it("refuses a marker on line 2", () => {
		const result = parseStatTiles(
			lines("Pilot sites: 3", "%% fabric-visual: a1b2c3d4e5f6"),
		);

		expect(reasonOf(result)).toContain(STAT_TILES_RULE);
	});

	it("refuses any other %% line after the first", () => {
		expect(
			parseStatTiles(lines("Pilot sites: 3", "%% note: draft")).ok,
		).toBe(false);
	});

	it("refuses a marker whose id is malformed", () => {
		for (const marker of [
			"%% fabric-visual: A1B2C3D4E5F6",
			"%% fabric-visual: short1",
			`%% fabric-visual: ${"a".repeat(33)}`,
			"%% fabric-visual: a1b2c3d4-e5f6",
			"%% fabric-visual:a1b2c3d4e5f6",
			"%% fabric-visual: a1b2c3d4e5f6 extra",
			"%% visual: a1b2c3d4e5f6",
		]) {
			expect(parseStatTiles(lines(marker, "Pilot sites: 3")).ok).toBe(
				false,
			);
		}
	});

	it("accepts the shortest and longest marker ids", () => {
		for (const id of ["a".repeat(12), "0".repeat(32)]) {
			const result = parseStatTiles(
				lines(`%% fabric-visual: ${id}`, "Pilot sites: 3"),
			);
			expect(result.ok && result.visualId).toBe(id);
		}
	});

	it("parses a CRLF body the same as an LF one", () => {
		const crlf = parseStatTiles(
			["%% fabric-visual: a1b2c3d4e5f6", THREE_ITEMS]
				.join("\n")
				.replace(/\n/g, "\r\n"),
		);

		expect(crlf).toEqual({
			ok: true,
			visualId: "a1b2c3d4e5f6",
			items: THREE_ITEMS_PARSED,
		});
	});

	it("keeps markup as plain text, under the same length rule", () => {
		const result = parseStatTiles("<script>alert(1)</script>: <b>40%</b>");
		expect(result.ok && result.items).toEqual([
			{ label: "<script>alert(1)</script>", value: "<b>40%</b>" },
		]);

		// 25 characters: refused for its length, like any other value.
		expect(parseStatTiles("Payload: <script>alert(1)</script>").ok).toBe(
			false,
		);
	});

	it("refuses a huge body before splitting it", () => {
		const huge = `Pilot sites: 3\n${" ".repeat(STAT_TILES_LIMITS.maxBodyLength)}`;
		const result = parseStatTiles(huge);

		expect(reasonOf(result)).toContain(STAT_TILES_RULE);
		expect(reasonOf(result)).toContain(
			String(STAT_TILES_LIMITS.maxBodyLength),
		);
	});

	it("reads a body at the length cap", () => {
		const body = `Pilot sites: 3\n${" ".repeat(STAT_TILES_LIMITS.maxBodyLength - 15)}`;
		expect(body.length).toBe(STAT_TILES_LIMITS.maxBodyLength);
		expect(parseStatTiles(body).ok).toBe(true);
	});

	it("keeps every reason on one line", () => {
		const refused = [
			"",
			"Annual savings",
			lines("Pilot sites: 3", "%% fabric-visual: a1b2c3d4e5f6"),
			"%% fabric-visual: BAD",
			`Savings: ${"x".repeat(25)}`,
			lines(THREE_ITEMS, "A: 1", "B: 2"),
		];
		for (const body of refused) {
			expect(reasonOf(parseStatTiles(body))).not.toMatch(/[\r\n]/);
		}
	});
});
