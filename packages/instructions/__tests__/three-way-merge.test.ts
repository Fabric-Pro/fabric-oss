import { describe, expect, it } from "vitest";
import {
	hasConflictMarkers,
	type MergeSide,
	mergeInstructionPath,
	threeWayMerge,
} from "../src/three-way-merge";

const labels = { ours: "proposal", theirs: "published v8" };

function side(text: string | null, hash = text ?? "binary"): MergeSide {
	return { hash, text };
}

describe("threeWayMerge", () => {
	it("keeps both sides when they change different lines", () => {
		const result = threeWayMerge(
			"a\nb\nc\nd\ne\n",
			"a\nB\nc\nd\ne\n",
			"a\nb\nc\nD\ne\n",
			labels,
		);
		expect(result).toEqual({ text: "a\nB\nc\nD\ne\n", conflicts: 0 });
	});

	it("returns the base unchanged when neither side changed it", () => {
		expect(threeWayMerge("a\nb\n", "a\nb\n", "a\nb\n", labels)).toEqual({
			text: "a\nb\n",
			conflicts: 0,
		});
	});

	it("takes the only side that changed", () => {
		expect(
			threeWayMerge("a\nb\n", "a\nb\nc\n", "a\nb\n", labels).text,
		).toBe("a\nb\nc\n");
		expect(
			threeWayMerge("a\nb\n", "a\nb\n", "x\na\nb\n", labels).text,
		).toBe("x\na\nb\n");
	});

	it("accepts the same change made on both sides", () => {
		expect(
			threeWayMerge("a\nb\nc\n", "a\nX\nc\n", "a\nX\nc\n", labels),
		).toEqual({ text: "a\nX\nc\n", conflicts: 0 });
	});

	it("keeps a deletion on one side and an edit elsewhere on the other", () => {
		expect(
			threeWayMerge(
				"a\nb\nc\nd\ne\n",
				"a\nc\nd\ne\n",
				"a\nb\nc\nd\nE\n",
				labels,
			),
		).toEqual({ text: "a\nc\nd\nE\n", conflicts: 0 });
	});

	it("writes a git-style conflict block when both sides change the same lines", () => {
		const result = threeWayMerge(
			"a\nb\nc\n",
			"a\nours\nc\n",
			"a\ntheirs\nc\n",
			labels,
		);
		expect(result.conflicts).toBe(1);
		expect(result.text).toBe(
			[
				"a",
				"<<<<<<< proposal",
				"ours",
				"=======",
				"theirs",
				">>>>>>> published v8",
				"c",
				"",
			].join("\n"),
		);
	});

	it("treats changes to adjacent lines as one conflicting region, as diff3 does", () => {
		const result = threeWayMerge(
			"a\nb\nc\n",
			"a\nB\nc\n",
			"a\nb\nC\n",
			labels,
		);
		expect(result.conflicts).toBe(1);
	});

	it("counts each conflicting region separately and keeps the clean ones", () => {
		const result = threeWayMerge(
			"1\n2\n3\n4\n5\n6\n7\n",
			"1\nA\n3\n4\n5\nB\n7\n",
			"1\nX\n3\nkeep\n5\nY\n7\n",
			labels,
		);
		expect(result.conflicts).toBe(2);
		expect(result.text).toContain("keep\n");
	});

	it("terminates a last line that has no newline before the next marker", () => {
		const result = threeWayMerge("a\nb", "a\nours", "a\ntheirs", labels);
		expect(result.text).toBe(
			"a\n<<<<<<< proposal\nours\n=======\ntheirs\n>>>>>>> published v8\n",
		);
	});

	it("writes markers with CRLF in a CRLF file", () => {
		const result = threeWayMerge(
			"a\r\nb\r\n",
			"a\r\nours\r\n",
			"a\r\ntheirs\r\n",
			labels,
		);
		expect(result.text).toBe(
			"a\r\n<<<<<<< proposal\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> published v8\r\n",
		);
	});

	it("merges an addition on each side at different ends", () => {
		expect(threeWayMerge("m\n", "top\nm\n", "m\nbottom\n", labels)).toEqual(
			{ text: "top\nm\nbottom\n", conflicts: 0 },
		);
	});

	it("conflicts when both sides append different text at the end", () => {
		const result = threeWayMerge("m\n", "m\nA\n", "m\nB\n", labels);
		expect(result.conflicts).toBe(1);
		expect(result.text.startsWith("m\n<<<<<<< proposal\nA\n")).toBe(true);
	});

	it("merges large files with distant edits quickly", () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`);
		const ours = [...lines];
		ours[10] = "ours\n";
		const theirs = [...lines];
		theirs[2900] = "theirs\n";
		const started = Date.now();
		const result = threeWayMerge(
			lines.join(""),
			ours.join(""),
			theirs.join(""),
			labels,
		);
		expect(result.conflicts).toBe(0);
		expect(result.text).toContain("ours\n");
		expect(result.text).toContain("theirs\n");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("gives up matching rather than exhausting memory on unrelated versions", () => {
		const base = Array.from({ length: 2500 }, (_, i) => `b${i}\n`).join("");
		const ours = Array.from({ length: 2500 }, (_, i) => `o${i}\n`).join("");
		const theirs = Array.from({ length: 2500 }, (_, i) => `t${i}\n`).join(
			"",
		);
		const result = threeWayMerge(base, ours, theirs, labels);
		expect(result.conflicts).toBe(1);
		expect(hasConflictMarkers(result.text)).toBe(true);
	});
});

describe("mergeInstructionPath", () => {
	it("reports a path both sides already agree on as unchanged", () => {
		expect(
			mergeInstructionPath({
				base: side("a\n"),
				ours: side("b\n"),
				theirs: side("b\n"),
				labels,
			}),
		).toEqual({ kind: "unchanged" });
		expect(
			mergeInstructionPath({
				base: side("a\n"),
				ours: null,
				theirs: null,
				labels,
			}),
		).toEqual({ kind: "unchanged" });
	});

	it("takes the proposal's version when only the proposal changed the path", () => {
		expect(
			mergeInstructionPath({
				base: side("a\n"),
				ours: null,
				theirs: side("a\n"),
				labels,
			}),
		).toEqual({ kind: "take-ours" });
		expect(
			mergeInstructionPath({
				base: null,
				ours: side("new\n"),
				theirs: null,
				labels,
			}),
		).toEqual({ kind: "take-ours" });
	});

	it("drops the path when only the published side changed it", () => {
		expect(
			mergeInstructionPath({
				base: side("a\n"),
				ours: side("a\n"),
				theirs: side("b\n"),
				labels,
			}),
		).toEqual({ kind: "take-theirs" });
	});

	it("merges a path both sides changed on different lines", () => {
		expect(
			mergeInstructionPath({
				base: side("a\nb\nc\n"),
				ours: side("A\nb\nc\n"),
				theirs: side("a\nb\nC\n"),
				labels,
			}),
		).toEqual({ kind: "merged", text: "A\nb\nC\n" });
	});

	it("conflicts when the proposal deleted a file the published side changed", () => {
		const result = mergeInstructionPath({
			base: side("a\n"),
			ours: null,
			theirs: side("b\n"),
			labels,
		});
		expect(result).toEqual({
			kind: "conflict",
			reason: "delete-edit",
			text: "<<<<<<< proposal\n=======\nb\n>>>>>>> published v8\n",
		});
	});

	it("conflicts when the published side deleted a file the proposal changed", () => {
		const result = mergeInstructionPath({
			base: side("a\n"),
			ours: side("b\n"),
			theirs: null,
			labels,
		});
		expect(result).toEqual({
			kind: "conflict",
			reason: "delete-edit",
			text: "<<<<<<< proposal\nb\n=======\n>>>>>>> published v8\n",
		});
	});

	it("conflicts without text when a binary file changed on both sides", () => {
		expect(
			mergeInstructionPath({
				base: side(null, "h1"),
				ours: side(null, "h2"),
				theirs: side(null, "h3"),
				labels,
			}),
		).toEqual({ kind: "conflict", reason: "binary", text: null });
		expect(
			mergeInstructionPath({
				base: side(null, "h1"),
				ours: null,
				theirs: side(null, "h3"),
				labels,
			}),
		).toEqual({ kind: "conflict", reason: "delete-edit", text: null });
	});

	it("still takes one side of a binary file when only that side changed", () => {
		expect(
			mergeInstructionPath({
				base: side(null, "h1"),
				ours: side(null, "h2"),
				theirs: side(null, "h1"),
				labels,
			}),
		).toEqual({ kind: "take-ours" });
	});

	it("merges two additions of the same path against an empty base", () => {
		expect(
			mergeInstructionPath({
				base: null,
				ours: side("x\n"),
				theirs: side("y\n"),
				labels,
			}),
		).toMatchObject({ kind: "conflict", reason: "content" });
	});
});

describe("hasConflictMarkers", () => {
	it("finds the start and end markers at the start of a line only", () => {
		expect(hasConflictMarkers("a\n<<<<<<< proposal\nb\n")).toBe(true);
		expect(hasConflictMarkers("a\n>>>>>>> published\n")).toBe(true);
		expect(hasConflictMarkers("a <<<<<<< b\n")).toBe(false);
	});

	it("does not mistake a setext heading underline for a marker", () => {
		expect(hasConflictMarkers("Title\n=======\n")).toBe(false);
	});
});
