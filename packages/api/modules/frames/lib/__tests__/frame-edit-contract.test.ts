import { expect, it } from "vitest";
import {
	frameContentEditSchema,
	frameRestoreSchema,
} from "../frame-edit-contract";

it("requires a reviewed revision and refuses publication fields", () => {
	expect(frameContentEditSchema.safeParse({ title: "Changed" }).success).toBe(
		false,
	);
	expect(
		frameContentEditSchema.safeParse({
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
			title: "Changed",
			isPublic: true,
		}).success,
	).toBe(false);
	expect(
		frameContentEditSchema.safeParse({
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
			title: "Changed",
		}).success,
	).toBe(true);
});
it("chooses exactly one stable restore target", () => {
	const expectedUpdatedAt = "2026-11-01T00:00:00Z";
	expect(
		frameRestoreSchema.safeParse({
			expectedUpdatedAt,
			historyEntryId: "example-entry",
		}).success,
	).toBe(true);
	expect(
		frameRestoreSchema.safeParse({
			expectedUpdatedAt,
			historyEntryId: "example-entry",
			toVersion: 1,
		}).success,
	).toBe(false);
	expect(frameRestoreSchema.safeParse({ expectedUpdatedAt }).success).toBe(
		false,
	);
});
