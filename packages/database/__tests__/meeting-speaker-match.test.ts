import { describe, expect, it } from "vitest";
import {
	buildMeetingSpeakers,
	buildRosterIndex,
	MEETING_PARTICIPANTS_CAP,
	matchSpeaker,
	normalizeName,
} from "../src/meeting-speaker-match";

describe("normalizeName", () => {
	it("lowercases, trims, and collapses inner whitespace", () => {
		expect(normalizeName("  Ada   Lovelace ")).toBe("ada lovelace");
		expect(normalizeName("ADA LOVELACE")).toBe("ada lovelace");
		expect(normalizeName("")).toBe("");
		expect(normalizeName("   ")).toBe("");
	});
});

describe("buildRosterIndex + matchSpeaker", () => {
	const roster = (rows: Array<[string, string | null]>) =>
		buildRosterIndex(
			rows.map(([userId, name]) => ({ userId, user: { name } })),
		);

	it("matches a member by exact normalized name", () => {
		const idx = roster([["u1", "Ada Lovelace"]]);
		expect(matchSpeaker("  ada   lovelace ", idx)).toBe("u1");
	});

	it("skips blank and Unknown speaker names", () => {
		const idx = roster([["u1", "Ada Lovelace"]]);
		expect(matchSpeaker("", idx)).toBeNull();
		expect(matchSpeaker("   ", idx)).toBeNull();
		expect(matchSpeaker("Unknown", idx)).toBeNull();
		expect(matchSpeaker("UNKNOWN", idx)).toBeNull();
	});

	it("fails closed when two DISTINCT members share a normalized name", () => {
		const idx = roster([
			["u1", "John Smith"],
			["u2", "john smith"],
		]);
		expect(matchSpeaker("John Smith", idx)).toBeNull();
	});

	it("still matches a single member that appears in two roster rows (self-invited owner)", () => {
		// getProjectMembers can emit the same userId twice (creator + accepted
		// self-invite). Distinct-id bucketing must collapse it, not suppress it.
		const idx = roster([
			["u1", "Ada Lovelace"],
			["u1", "Ada Lovelace"],
		]);
		expect(matchSpeaker("Ada Lovelace", idx)).toBe("u1");
	});

	it("does not match a non-member name, or a member with a blank name", () => {
		const idx = roster([
			["u1", "Ada Lovelace"],
			["u2", null],
		]);
		expect(matchSpeaker("Grace Hopper", idx)).toBeNull();
		expect(matchSpeaker("", idx)).toBeNull();
	});
});

describe("buildMeetingSpeakers", () => {
	it("returns null for no matches", () => {
		expect(buildMeetingSpeakers([])).toBeNull();
	});

	it("orders by normalized name asc then id, and reports no overflow under the cap", () => {
		const v = buildMeetingSpeakers([
			{ id: "u2", name: "Grace Hopper", username: "grace" },
			{ id: "u1", name: "Ada Lovelace", username: "ada" },
		]);
		expect(v?.members.map((m) => m.id)).toEqual(["u1", "u2"]);
		expect(v?.overflowCount).toBe(0);
	});

	it("caps at MEETING_PARTICIPANTS_CAP and reports overflow", () => {
		const many = ["e", "d", "c", "b", "a"].map((c, i) => ({
			id: `u${i}`,
			name: `${c} person`,
			username: null,
		}));
		const v = buildMeetingSpeakers(many);
		expect(v?.members).toHaveLength(MEETING_PARTICIPANTS_CAP);
		expect(v?.members.map((m) => m.name)).toEqual([
			"a person",
			"b person",
			"c person",
		]);
		expect(v?.overflowCount).toBe(2);
	});
});
