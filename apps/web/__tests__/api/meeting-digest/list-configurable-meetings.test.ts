import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, hasAccess } = vi.hoisted(() => ({
	findMany: vi.fn(),
	hasAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		db: {
			...actual.db,
			projectLinkedMeeting: { findMany },
		},
		hasProjectAccess: hasAccess,
	};
});

import { toConfigRows } from "@repo/api/modules/projects/procedures/meeting-digest/list-configurable-meetings";

describe("toConfigRows", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps id to linkedMeetingId and preserves subject and includedInDigest", () => {
		const rows = toConfigRows(
			[
				{
					id: "lm1",
					subject: "Fabric Dev Sync",
					includedInDigest: true,
				},
				{ id: "lm2", subject: null, includedInDigest: false },
			],
			new Map(),
		);

		expect(rows).toEqual([
			{
				linkedMeetingId: "lm1",
				subject: "Fabric Dev Sync",
				includedInDigest: true,
				lastMeetingDate: null,
			},
			{
				linkedMeetingId: "lm2",
				subject: null,
				includedInDigest: false,
				lastMeetingDate: null,
			},
		]);
	});

	it("preserves input order", () => {
		const rows = toConfigRows(
			[
				{ id: "z", subject: "Zzz", includedInDigest: false },
				{ id: "a", subject: "Aaa", includedInDigest: true },
			],
			new Map(),
		);

		expect(rows.map((r) => r.linkedMeetingId)).toEqual(["z", "a"]);
	});

	it("returns an empty array when given an empty list", () => {
		expect(toConfigRows([], new Map())).toEqual([]);
	});

	it("includes each series' latest meeting date, null when never synced", () => {
		const rows = toConfigRows(
			[
				{ id: "lm1", subject: "DSU", includedInDigest: true },
				{ id: "lm2", subject: "Retro", includedInDigest: true },
			],
			new Map([["lm1", new Date("2026-04-30T18:30:00Z")]]),
		);
		expect(rows[0].lastMeetingDate).toEqual(
			new Date("2026-04-30T18:30:00Z"),
		);
		expect(rows[1].lastMeetingDate).toBeNull();
	});
});
