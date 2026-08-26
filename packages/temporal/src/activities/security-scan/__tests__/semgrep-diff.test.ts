import { describe, expect, it, vi } from "vitest";
import { computeSemgrepDiffScope, parseDiffNameOnly } from "../semgrep-scan";

describe("parseDiffNameOnly — git diff --name-only → changed paths", () => {
	it("parses one path per line, trimming and dropping blanks", () => {
		expect(
			parseDiffNameOnly("src/a.ts\nsrc/b.ts\n\n  src/c.ts  \n"),
		).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	it("tolerates CRLF and de-dupes repeated paths", () => {
		expect(
			parseDiffNameOnly("src/a.ts\r\nsrc/a.ts\r\nsrc/b.ts\r\n"),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("returns [] for empty / non-string input", () => {
		expect(parseDiffNameOnly("")).toEqual([]);
		// @ts-expect-error — defensive: tolerate a non-string at runtime.
		expect(parseDiffNameOnly(undefined)).toEqual([]);
	});
});

describe("computeSemgrepDiffScope — targets vs carry-forward keys", () => {
	const opts = (over: {
		diff: string;
		exists: (p: string) => boolean;
		fetchThrows?: boolean;
		diffThrows?: boolean;
	}) => ({
		baseSha: "base",
		targetSha: "target",
		fetchBase: vi.fn(async () => {
			if (over.fetchThrows) {
				throw new Error("unreachable base");
			}
		}),
		diffNames: vi.fn(async () => {
			if (over.diffThrows) {
				throw new Error("bad range");
			}
			return over.diff;
		}),
		fileExists: vi.fn(async (p: string) => over.exists(p)),
	});

	it("returns both changed paths and existing scan targets when all files exist", async () => {
		const scope = await computeSemgrepDiffScope(
			opts({ diff: "src/a.ts\nsrc/b.ts", exists: () => true }),
		);
		expect(scope).toEqual({
			changedFilePaths: ["src/a.ts", "src/b.ts"],
			scanTargets: ["src/a.ts", "src/b.ts"],
		});
	});

	it("a rename (delete old + add new) scans the new path, excludes the deleted one", async () => {
		// A rename surfaces as delete `src/old.ts` + add `src/new.ts`.
		const scope = await computeSemgrepDiffScope(
			opts({
				diff: "src/old.ts\nsrc/new.ts",
				exists: (p) => p === "src/new.ts",
			}),
		);
		// Both are changed (so both drop prior findings)…
		expect(scope?.changedFilePaths).toEqual(["src/old.ts", "src/new.ts"]);
		// …but only the still-existing new path is scanned.
		expect(scope?.scanTargets).toEqual(["src/new.ts"]);
	});

	it("a delete-only diff yields no scan targets but still reports the changed path", async () => {
		const scope = await computeSemgrepDiffScope(
			opts({ diff: "src/gone.ts", exists: () => false }),
		);
		expect(scope?.changedFilePaths).toEqual(["src/gone.ts"]);
		expect(scope?.scanTargets).toEqual([]);
	});

	it("returns null when the base fetch throws (→ caller falls back to a full scan)", async () => {
		const scope = await computeSemgrepDiffScope(
			opts({ diff: "", exists: () => true, fetchThrows: true }),
		);
		expect(scope).toBeNull();
	});

	it("returns null when the diff throws", async () => {
		const scope = await computeSemgrepDiffScope(
			opts({ diff: "", exists: () => true, diffThrows: true }),
		);
		expect(scope).toBeNull();
	});
});
