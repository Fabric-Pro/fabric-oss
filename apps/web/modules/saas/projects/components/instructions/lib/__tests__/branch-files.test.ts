/**
 * The tree's view of the member's own proposal branch: which published files
 * the branch changes or deletes, and which files only the branch holds.
 */
import { classifyPath } from "@repo/instructions";
import { describe, expect, it } from "vitest";
import {
	type BranchProjectionFile,
	branchMarkerOf,
	withBranchFiles,
} from "../branch-files";

function entry(
	path: string,
	state: BranchProjectionFile["state"],
	objectId: string | null = null,
): BranchProjectionFile {
	return { path, state, objectId };
}

describe("branchMarkerOf", () => {
	it("marks a written file the published version lacks as branch-only", () => {
		expect(
			branchMarkerOf(undefined, entry("rules/new.md", "written", "b1")),
		).toBe("branchOnly");
	});

	it("leaves out an unpublished path the branch deleted or never stored", () => {
		expect(
			branchMarkerOf(undefined, entry("gone.md", "deleted")),
		).toBeNull();
		expect(
			branchMarkerOf(
				undefined,
				entry("old.md", "restored_unavailable", "b2"),
			),
		).toBeNull();
	});

	it("marks a published file the branch deletes", () => {
		expect(
			branchMarkerOf({ blobId: "p1" }, entry("AGENTS.md", "deleted")),
		).toBe("deletedOnBranch");
	});

	it("marks a published file only when the branch's bytes differ", () => {
		expect(
			branchMarkerOf(
				{ blobId: "p1" },
				entry("AGENTS.md", "written", "p1"),
			),
		).toBeNull();
		expect(
			branchMarkerOf(
				{ blobId: "p1" },
				entry("AGENTS.md", "written", "b9"),
			),
		).toBe("changedOnBranch");
		expect(branchMarkerOf({}, entry("AGENTS.md", "written", "b9"))).toBe(
			"changedOnBranch",
		);
	});
});

describe("withBranchFiles", () => {
	const published = [
		{ path: "AGENTS.md", kind: "AGENTS", blobId: "p1" },
		{ path: "rules/a.md", kind: "RULE", blobId: "p2" },
		{ path: "rules/b.md", kind: "RULE", blobId: "p3" },
	];

	it("returns the published files unmarked, without their blob ids, when the branch holds nothing", () => {
		expect(withBranchFiles(published, [])).toEqual([
			{ path: "AGENTS.md", kind: "AGENTS" },
			{ path: "rules/a.md", kind: "RULE" },
			{ path: "rules/b.md", kind: "RULE" },
		]);
	});

	it("marks changed and deleted published files and appends the branch-only ones", () => {
		const files = withBranchFiles(published, [
			entry("AGENTS.md", "written", "p1"),
			entry("rules/a.md", "written", "b2"),
			entry("rules/b.md", "deleted"),
			entry("rules/new.md", "written", "b4"),
			entry("never-published.md", "deleted"),
		]);

		expect(files).toEqual([
			{ path: "AGENTS.md", kind: "AGENTS" },
			{ path: "rules/a.md", kind: "RULE", branch: "changedOnBranch" },
			{ path: "rules/b.md", kind: "RULE", branch: "deletedOnBranch" },
			{
				path: "rules/new.md",
				kind: classifyPath("rules/new.md"),
				branch: "branchOnly",
			},
		]);
	});
});
