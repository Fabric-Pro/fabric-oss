import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import {
	leaveOutOfLivingMemory,
	placeLeftOutPaths,
	restoreToLivingMemory,
} from "../useLivingMemoryExclusion";

describe("leaveOutOfLivingMemory", () => {
	it("leaves a file inside a selected folder out of the sync", () => {
		expect(
			leaveOutOfLivingMemory(
				{ paths: ["docs"], excludedPaths: ["docs/old.md"] },
				"docs/draft.md",
			),
		).toEqual({
			ok: true,
			selection: {
				paths: ["docs"],
				excludedPaths: ["docs/draft.md", "docs/old.md"],
			},
		});
	});

	it("unselects a file selected on its own", () => {
		expect(
			leaveOutOfLivingMemory(
				{ paths: ["README.md", "docs"], excludedPaths: [] },
				"README.md",
			),
		).toEqual({
			ok: true,
			selection: { paths: ["docs"], excludedPaths: [] },
		});
	});

	it("refuses to remove the only selected path", () => {
		expect(
			leaveOutOfLivingMemory(
				{ paths: ["README.md"], excludedPaths: [] },
				"README.md",
			),
		).toEqual({ ok: false, code: "LAST_PATH" });
	});

	it("refuses past the left-out cap", () => {
		const excludedPaths = Array.from(
			{ length: 200 },
			(_, i) => `docs/f${String(i).padStart(3, "0")}.md`,
		);
		expect(
			leaveOutOfLivingMemory(
				{ paths: ["docs"], excludedPaths },
				"docs/x.md",
			),
		).toEqual({ ok: false, code: "TOO_MANY_EXCLUDED_PATHS" });
	});
});

describe("restoreToLivingMemory", () => {
	it("takes the path off the left-out list", () => {
		expect(
			restoreToLivingMemory(
				{ paths: ["docs"], excludedPaths: ["docs/a.md", "docs/b.md"] },
				"docs/a.md",
			),
		).toEqual({
			ok: true,
			selection: { paths: ["docs"], excludedPaths: ["docs/b.md"] },
		});
	});
});

describe("placeLeftOutPaths", () => {
	it("puts a left-out path in the folder it was left out of, when shown", () => {
		const placed = placeLeftOutPaths(
			["", "docs"],
			[
				"README-old.md",
				"docs/draft.md",
				"docs/old/notes.md",
				"specs/a.md",
			],
		);
		expect(Object.fromEntries(placed.byFolder)).toEqual({
			"": ["README-old.md"],
			docs: ["docs/draft.md"],
		});
		expect(placed.elsewhere).toEqual(["docs/old/notes.md", "specs/a.md"]);
	});
});
