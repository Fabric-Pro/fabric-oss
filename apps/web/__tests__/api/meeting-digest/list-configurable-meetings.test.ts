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

import {
	toConfigRows,
	toParlumeAutoJoinState,
} from "@repo/api/modules/projects/procedures/meeting-digest/list-configurable-meetings";

describe("toParlumeAutoJoinState", () => {
	const row = {
		deactivatedAt: null,
		parlumeAutoJoin: true,
		parlumeAutoJoinToolsReadOnly: false,
		parlumeAutoJoinSuggestions: true,
		parlumeAutoJoinSuggestionAudience: "TEAM" as const,
		parlumeAutoJoinError: "Reconnect Microsoft in Settings → Integrations.",
		parlumeAutoJoinErrorAt: new Date("2026-10-27T09:00:00Z"),
		parlumeAutoJoinUser: { id: "user-1", name: "Dev Example" },
		parlumeAutoJoinEnabledAt: new Date("2026-10-20T08:00:00Z"),
	};

	it("names who turned auto-join on and when, and carries its last error", () => {
		expect(toParlumeAutoJoinState(row)).toEqual({
			enabled: true,
			toolsReadOnly: false,
			suggestionsEnabled: true,
			suggestionAudience: "TEAM",
			enabledBy: { id: "user-1", name: "Dev Example" },
			enabledAt: new Date("2026-10-20T08:00:00Z"),
			error: "Reconnect Microsoft in Settings → Integrations.",
			errorAt: new Date("2026-10-27T09:00:00Z"),
			syncStopped: false,
		});
	});

	it("marks a series whose syncing is stopped", () => {
		expect(
			toParlumeAutoJoinState({
				...row,
				deactivatedAt: new Date("2026-10-01T00:00:00Z"),
			}).syncStopped,
		).toBe(true);
	});

	it("names no enabler and no time while the switch is off", () => {
		const off = toParlumeAutoJoinState({ ...row, parlumeAutoJoin: false });
		expect(off.enabledBy).toBeNull();
		expect(off.enabledAt).toBeNull();
	});
});

describe("toConfigRows", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps id to linkedMeetingId and preserves subject, includedInDigest and confidential", () => {
		const rows = toConfigRows(
			[
				{
					id: "lm1",
					subject: "Fabric Dev Sync",
					includedInDigest: true,
					confidential: false,
				},
				{
					id: "lm2",
					subject: null,
					includedInDigest: false,
					confidential: true,
				},
			],
			new Map(),
		);

		expect(rows).toEqual([
			{
				linkedMeetingId: "lm1",
				subject: "Fabric Dev Sync",
				includedInDigest: true,
				confidential: false,
				lastMeetingDate: null,
			},
			{
				linkedMeetingId: "lm2",
				subject: null,
				includedInDigest: false,
				confidential: true,
				lastMeetingDate: null,
			},
		]);
	});

	it("preserves input order", () => {
		const rows = toConfigRows(
			[
				{
					id: "z",
					subject: "Zzz",
					includedInDigest: false,
					confidential: false,
				},
				{
					id: "a",
					subject: "Aaa",
					includedInDigest: true,
					confidential: false,
				},
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
				{
					id: "lm1",
					subject: "DSU",
					includedInDigest: true,
					confidential: false,
				},
				{
					id: "lm2",
					subject: "Retro",
					includedInDigest: true,
					confidential: false,
				},
			],
			new Map([["lm1", new Date("2026-04-30T18:30:00Z")]]),
		);
		expect(rows[0].lastMeetingDate).toEqual(
			new Date("2026-04-30T18:30:00Z"),
		);
		expect(rows[1].lastMeetingDate).toBeNull();
	});
});
