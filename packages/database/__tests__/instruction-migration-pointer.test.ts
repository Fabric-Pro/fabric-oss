import { describe, expect, it } from "vitest";
import {
	destinationSourceOfTruth,
	migrationOfSettings,
	parseInstructionMigrationPointer,
} from "../prisma/queries/instruction-migration-pointer";

const POINTER = {
	v: 1,
	state: "PROPOSING",
	branchId: null,
	snapshotId: null,
	syncId: "sync-1",
	pullRequestUrl: null,
	startedAt: "2026-10-03T10:00:00.000Z",
	userId: "user-1",
} as const;

describe("parseInstructionMigrationPointer", () => {
	it("reads a pointer as written", () => {
		expect(parseInstructionMigrationPointer({ ...POINTER })).toEqual(
			POINTER,
		);
		expect(
			parseInstructionMigrationPointer({
				...POINTER,
				state: "SWITCHING",
				branchId: "branch-1",
				snapshotId: "snap-1",
				pullRequestUrl: "https://example.com/pull/7",
			}),
		).toMatchObject({
			state: "SWITCHING",
			branchId: "branch-1",
			snapshotId: "snap-1",
			pullRequestUrl: "https://example.com/pull/7",
		});
	});

	it.each([
		["a missing value", undefined],
		["null", null],
		["an array", []],
		["another version", { ...POINTER, v: 2 }],
		["a state this code does not know", { ...POINTER, state: "OPEN" }],
		["a sync id that is not text", { ...POINTER, syncId: 3 }],
		["no author", { ...POINTER, userId: undefined }],
		[
			"a branch id that is neither text nor null",
			{ ...POINTER, branchId: 5 },
		],
	])("reads %s as no pointer", (_name, raw) => {
		expect(parseInstructionMigrationPointer(raw)).toBeNull();
	});

	it("drops keys it does not know instead of carrying them forward", () => {
		const parsed = parseInstructionMigrationPointer({
			...POINTER,
			stray: "kept?",
		});
		expect(parsed).not.toHaveProperty("stray");
	});
});

describe("migrationOfSettings", () => {
	it("finds the pointer in a project's settings and only there", () => {
		expect(
			migrationOfSettings({
				sourceOfTruth: "UPLOAD",
				migration: POINTER,
			}),
		).toEqual(POINTER);
		expect(migrationOfSettings({ sourceOfTruth: "UPLOAD" })).toBeNull();
		expect(migrationOfSettings(null)).toBeNull();
		expect(migrationOfSettings("migration")).toBeNull();
	});
});

describe("destinationSourceOfTruth", () => {
	it("is REPOSITORY while a move is proposing for that sync row", () => {
		expect(
			destinationSourceOfTruth(
				{ sourceOfTruth: "UPLOAD", migration: POINTER },
				"sync-1",
			),
		).toBe("REPOSITORY");
		expect(destinationSourceOfTruth({ migration: POINTER }, "sync-1")).toBe(
			"REPOSITORY",
		);
	});

	it("never lends the destination to another sync row", () => {
		expect(
			destinationSourceOfTruth(
				{ sourceOfTruth: "UPLOAD", migration: POINTER },
				"another-sync",
			),
		).toBe("UPLOAD");
		expect(
			destinationSourceOfTruth(
				{ sourceOfTruth: "UPLOAD", migration: POINTER },
				null,
			),
		).toBe("UPLOAD");
	});

	it("is the stored value once the move has switched or when none is open", () => {
		expect(
			destinationSourceOfTruth(
				{
					sourceOfTruth: "REPOSITORY",
					migration: { ...POINTER, state: "SWITCHING" },
				},
				"sync-1",
			),
		).toBe("REPOSITORY");
		expect(
			destinationSourceOfTruth(
				{
					sourceOfTruth: "UPLOAD",
					migration: { ...POINTER, state: "SWITCHING" },
				},
				"sync-1",
			),
		).toBe("UPLOAD");
		expect(
			destinationSourceOfTruth({ sourceOfTruth: "UPLOAD" }, "sync-1"),
		).toBe("UPLOAD");
		expect(destinationSourceOfTruth(null, "sync-1")).toBeNull();
	});
});
