import { describe, expect, it } from "vitest";
import {
	orderStoriesBySemanticActivity,
	storySemanticActivityAt,
} from "../story-semantic-activity";

const at = (iso: string) => new Date(iso);

describe("story semantic activity", () => {
	it("uses creation for never-edited stories", () => {
		const createdAt = at("2026-08-10T12:00:00.000Z");
		expect(storySemanticActivityAt({ createdAt, lastEditedAt: null })).toBe(
			createdAt,
		);
	});

	it("orders edited and never-edited stories by their exact activity time", () => {
		const rows = [
			{
				id: "old-edit",
				createdAt: at("2026-01-01T00:00:00.000Z"),
				lastEditedAt: at("2026-08-01T00:00:00.000Z"),
			},
			{
				id: "new-creation",
				createdAt: at("2026-08-09T00:00:00.000Z"),
				lastEditedAt: null,
			},
			{
				id: "new-edit",
				createdAt: at("2026-02-01T00:00:00.000Z"),
				lastEditedAt: at("2026-08-10T00:00:00.000Z"),
			},
		];

		expect(
			orderStoriesBySemanticActivity(rows).map((row) => row.id),
		).toEqual(["new-edit", "new-creation", "old-edit"]);
		expect(
			orderStoriesBySemanticActivity(rows, "asc").map((row) => row.id),
		).toEqual(["old-edit", "new-creation", "new-edit"]);
	});

	it("uses id as a deterministic tie-break", () => {
		const sameTime = at("2026-08-10T00:00:00.000Z");
		const rows = [
			{ id: "b", createdAt: sameTime, lastEditedAt: null },
			{ id: "a", createdAt: sameTime, lastEditedAt: sameTime },
		];

		expect(
			orderStoriesBySemanticActivity(rows).map((row) => row.id),
		).toEqual(["a", "b"]);
	});
});
