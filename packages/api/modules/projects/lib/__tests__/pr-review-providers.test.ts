/**
 * The provider seam: one unified diff, whatever the host returned.
 *
 * GitHub hands back a unified diff for a whole pull request. GitLab and Azure
 * return per-file structures, and this is where those become the one format the
 * rest of the feature reads. That matters more than it sounds: `diffFilePaths`
 * decides whether a finding cites a file the change actually touched by parsing
 * these headers, and a finding that fails that check is discarded. A host whose
 * diff lacks them would have every one of its findings dropped as ungrounded,
 * silently, and the reviewer would look broken rather than misassembled.
 */

import { diffAddedLines, diffFilePaths } from "@repo/ai";
import { describe, expect, it } from "vitest";
import { providerFor } from "../pr-review-hosts";
import {
	packAzureCommentId,
	toUnifiedDiff,
	truncateToBytes,
	unpackAzureCommentId,
} from "../pr-review-providers";

describe("toUnifiedDiff", () => {
	it("emits headers the grounding filter can parse", () => {
		const diff = toUnifiedDiff([
			{
				path: "src/pay.ts",
				diff: "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;",
			},
		]);

		// The whole point: the shared parser must find this file, or every finding
		// citing it is thrown away as invented.
		expect(diffFilePaths(diff).has("src/pay.ts")).toBe(true);
		expect(diff).toContain("diff --git a/src/pay.ts b/src/pay.ts");
		expect(diff).toContain("+++ b/src/pay.ts");
	});

	it("keeps line numbers the grounding filter will accept", () => {
		const diff = toUnifiedDiff([
			{
				path: "src/pay.ts",
				diff: "@@ -10,1 +10,2 @@\n const a = 1;\n+const b = 2;",
			},
		]);

		// Line 11 is the added one. A finding citing it must survive; one citing
		// a line the diff never added must not.
		const added = diffAddedLines(diff).get("src/pay.ts");
		expect(added?.has(11)).toBe(true);
		expect(added?.has(999)).toBe(false);
	});

	it("marks a new file so the old side reads as /dev/null", () => {
		const diff = toUnifiedDiff([
			{
				path: "src/new.ts",
				diff: "@@ -0,0 +1,1 @@\n+hello",
				isNew: true,
			},
		]);

		expect(diff).toContain("new file mode");
		expect(diff).toContain("--- /dev/null");
		expect(diff).toContain("+++ b/src/new.ts");
	});

	it("marks a deletion so the new side reads as /dev/null", () => {
		const diff = toUnifiedDiff([
			{
				path: "src/old.ts",
				diff: "@@ -1,1 +0,0 @@\n-bye",
				isDeleted: true,
			},
		]);

		expect(diff).toContain("deleted file mode");
		expect(diff).toContain("+++ /dev/null");
		// Both sides stay citable: a finding about a deleted file is legitimate.
		expect(diffFilePaths(diff).has("src/old.ts")).toBe(true);
	});

	it("names both paths of a rename, so either one grounds a finding", () => {
		const diff = toUnifiedDiff([
			{
				path: "src/new-name.ts",
				previousPath: "src/old-name.ts",
				diff: "@@ -1,1 +1,1 @@\n-a\n+b",
				isRenamed: true,
			},
		]);

		const paths = diffFilePaths(diff);
		expect(paths.has("src/new-name.ts")).toBe(true);
		expect(paths.has("src/old-name.ts")).toBe(true);
		expect(diff).toContain("rename from src/old-name.ts");
	});

	it("joins several files into one diff the parser walks end to end", () => {
		const diff = toUnifiedDiff([
			{ path: "a.ts", diff: "@@ -1,1 +1,2 @@\n x\n+y" },
			{ path: "b.ts", diff: "@@ -5,1 +5,2 @@\n p\n+q" },
		]);

		const paths = diffFilePaths(diff);
		expect(paths.has("a.ts")).toBe(true);
		expect(paths.has("b.ts")).toBe(true);
		// The second file's hunk restarts its own count rather than continuing.
		expect(diffAddedLines(diff).get("b.ts")?.has(6)).toBe(true);
	});

	it("returns nothing for no files, rather than a header with no body", () => {
		expect(toUnifiedDiff([])).toBe("");
	});
});

describe("Azure comment identity", () => {
	// Azure addresses a comment by thread AND comment, and every other host by
	// one id. Packing both into the single column keeps the storage identical
	// across hosts; the arithmetic has to survive a round trip exactly.
	it("round-trips a thread and comment id", () => {
		const packed = packAzureCommentId(4321, 7);

		expect(unpackAzureCommentId(packed)).toEqual({
			threadId: 4321,
			commentId: 7,
		});
	});

	it("round-trips the first comment of the first thread", () => {
		expect(unpackAzureCommentId(packAzureCommentId(1, 1))).toEqual({
			threadId: 1,
			commentId: 1,
		});
	});

	it("stays inside a safe integer for a realistic thread id", () => {
		const packed = packAzureCommentId(9_999_999, 999);

		expect(Number.isSafeInteger(packed)).toBe(true);
		expect(unpackAzureCommentId(packed).threadId).toBe(9_999_999);
	});
});

describe("providerFor", () => {
	it.each(["GITHUB", "GITLAB", "AZURE_DEVOPS"])(
		"implements %s",
		(provider) => {
			const host = providerFor(provider);

			expect(host).not.toBeNull();
			// All three answer the same three questions, which is what lets the read
			// and comment paths stay provider-agnostic.
			expect(typeof host?.read).toBe("function");
			expect(typeof host?.createComment).toBe("function");
			expect(typeof host?.editComment).toBe("function");
		},
	);

	it("returns null for a host nobody implemented", () => {
		// The callers turn this into a refusal naming the provider, rather than
		// failing deeper with something unreadable.
		expect(providerFor("BITBUCKET")).toBeNull();
	});
});

describe("Azure's diff is a real diff, not the whole file twice", () => {
	// It used to emit every old line as `-` and every new line as `+`. That is
	// legal unified diff and useless: a one-line edit to a 500-line file produced
	// 1,000 changed lines, and `diffAddedLines` marked every line in the file as
	// added, so the grounding filter, whose whole job is rejecting invented line
	// citations, would have verified a citation to any line at all.
	//
	// `azureFileDiff` is not exported (it takes a token and does I/O), so this
	// pins the property through the library it now uses, which is the part that
	// was wrong.
	it("reports only the changed line as added, not the whole file", async () => {
		const { structuredPatch } = await import("diff");
		const before = Array.from(
			{ length: 200 },
			(_, i) => `line ${i + 1}`,
		).join("\n");
		const after = before.replace("line 100", "line 100 CHANGED");

		const patch = structuredPatch("f.ts", "f.ts", before, after, "", "", {
			context: 3,
		});
		const rendered = patch.hunks
			.map((h) =>
				[
					`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
					...h.lines,
				].join("\n"),
			)
			.join("\n");
		const diff = toUnifiedDiff([{ path: "f.ts", diff: rendered }]);

		const added = diffAddedLines(diff).get("f.ts");
		// The changed line grounds.
		expect(added?.has(100)).toBe(true);
		// A line nowhere near it does not, which is the whole point.
		expect(added?.has(5)).toBe(false);
		expect(added?.has(199)).toBe(false);
		// And the payload stays small rather than doubling the file.
		expect(diff.split("\n").length).toBeLessThan(20);
	});
});

describe("truncateToBytes", () => {
	// The cap is named in bytes and used to compare UTF-16 units, so a diff heavy
	// in non-ASCII sat well past it while the check said otherwise. Fixing that
	// introduced a second problem: cutting a buffer mid-character and decoding it
	// produces U+FFFD, a character the source never had.
	it("counts bytes, not characters", () => {
		const euros = "€".repeat(10); // 3 bytes each, 10 UTF-16 units

		expect(truncateToBytes(euros, 40).truncated).toBe(false);
		expect(truncateToBytes(euros, 20).truncated).toBe(true);
	});

	it("never emits a replacement character, even with no line to cut on", () => {
		// A minified asset or an embedded blob has no newline inside the budget,
		// which is exactly the case the cap exists for.
		const unbroken = "x".repeat(5) + "€".repeat(5);

		const result = truncateToBytes(unbroken, 7);

		expect(result.truncated).toBe(true);
		expect(result.text).not.toContain("�");
		expect(result.text).toBe("xxxxx");
	});

	it("handles a line break at position zero", () => {
		const result = truncateToBytes("\n" + "€".repeat(10), 5);

		expect(result.text).not.toContain("�");
	});

	it("cuts on a line boundary when there is one", () => {
		const lines = ["@@ -1,1 +1,1 @@", "-a", "+b", "@@ -9,1 +9,1 @@"].join(
			"\n",
		);

		const result = truncateToBytes(lines, 25);

		// A half-written hunk header states a line number that does not exist, and
		// the grounding filter would discard every finding citing it.
		expect(result.text.endsWith("\n")).toBe(false);
		expect(result.text).not.toContain("@@ -9,1");
	});

	it("leaves a diff under the cap exactly as it was", () => {
		expect(truncateToBytes("small", 100)).toEqual({
			text: "small",
			truncated: false,
		});
	});
});
