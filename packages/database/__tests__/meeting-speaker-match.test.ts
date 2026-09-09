import { describe, expect, it } from "vitest";
import {
	buildMeetingSpeakers,
	buildRosterIndex,
	MEETING_PARTICIPANTS_CAP,
	MEETING_PARTICIPANTS_DETAIL_CAP,
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

	// The single-topic read raises the cap so the Topic Item Page can unfold
	// the names the Inbox line has no room for. The Inbox itself keeps the
	// tight cap, which is why the default above is the one that must not move.
	it("honours a caller-supplied cap and still reports the remainder", () => {
		const many = ["e", "d", "c", "b", "a"].map((c, i) => ({
			id: `u${i}`,
			name: `${c} person`,
			username: null,
		}));

		const v = buildMeetingSpeakers(many, 4);
		expect(v?.members.map((m) => m.name)).toEqual([
			"a person",
			"b person",
			"c person",
			"d person",
		]);
		expect(v?.overflowCount).toBe(1);
	});

	it("orders BEFORE it caps, so a raised cap only ever appends", () => {
		// Load-bearing for the topic page: the collapsed line there shows the
		// first three of a 25-cap payload, and those have to be the same three
		// the Inbox row showed from its 3-cap payload. If the cap were applied
		// to the unsorted input this would fail, and the two views would name
		// different people for the same meeting.
		const many = ["e", "d", "c", "b", "a"].map((c, i) => ({
			id: `u${i}`,
			name: `${c} person`,
			username: null,
		}));

		const tight = buildMeetingSpeakers(many, MEETING_PARTICIPANTS_CAP);
		const wide = buildMeetingSpeakers(
			many,
			MEETING_PARTICIPANTS_DETAIL_CAP,
		);

		expect(wide?.members.slice(0, MEETING_PARTICIPANTS_CAP)).toEqual(
			tight?.members,
		);
		expect(wide?.members).toHaveLength(5);
		expect(wide?.overflowCount).toBe(0);
	});
});

describe("MEETING_PARTICIPANTS_DETAIL_CAP", () => {
	it("is wider than the Inbox cap, which is what gives the topic page something to unfold", () => {
		expect(MEETING_PARTICIPANTS_DETAIL_CAP).toBeGreaterThan(
			MEETING_PARTICIPANTS_CAP,
		);
	});
});
