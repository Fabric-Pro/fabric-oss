/**
 * The implementation-verifier persona says the same thing to every tool.
 *
 * The persona exists five times over, once per coding tool, because each wants
 * its own frontmatter and its own directory. Nothing kept the bodies in step, so
 * they drifted: three carried a Security checklist and two did not, at three
 * different heading levels. An agent's thoroughness therefore depended on which
 * editor happened to be open, which is not a property anybody chose.
 *
 * This asserts on CONTENT, not formatting. The heading levels legitimately
 * differ — `.cursor/rules` uses `##` where `.augment/rules` uses `####` — and
 * forcing those to match would be fighting the tools rather than the drift.
 * What must match is the checks the persona actually performs.
 *
 * Security is now on that list. It was the section that drifted, and it was the
 * one section this file did not guard, which is not a coincidence: an unguarded
 * check is the only kind that can go missing.
 *
 * A sixth copy added without the shared checks fails here, which is the point:
 * the question "which copy is canonical?" stops being load-bearing once no copy
 * is allowed to fall behind.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Every place this persona is published. Add a tool here when one is added.
 *
 * Each path is the directory that tool actually scans, which is not a single
 * convention: Factory reads `.factory/droids/`, not an `agents/` folder, so
 * renaming it for consistency would leave Factory with no persona at all.
 */
const COPIES = [
	".augment/rules/implementation-verifier.md",
	".claude/agents/implementation-verifier.md",
	".cursor/agents/implementation-verifier.md",
	".cursor/rules/implementation-verifier.mdc",
	".factory/droids/implementation-verifier.md",
	".github/copilot/agents/implementation-verifier.md",
] as const;

/**
 * The checks the persona must carry everywhere, each identified by a phrase
 * distinctive enough that a reworded copy still matches only if it kept the
 * check. Matching on a whole block would fail on a reflow; matching on a single
 * word would pass on a mention in passing.
 */
const REQUIRED = [
	{
		name: "ownership check on mutations",
		phrase: "Every oRPC mutation carries",
	},
	{ name: "Temporal non-determinism", phrase: "inside a Temporal workflow" },
	{ name: "deep-path imports", phrase: "not a deep path into its internals" },
	// Not "acceptance criteria": four of the six copies have said that in their
	// own prose since long before this check existed, so for those the phrase
	// matched whether or not the check was there. A guard that cannot fail on
	// most of what it guards is worse than none, because it reads as coverage.
	{
		name: "acceptance-criteria reading",
		phrase: "plausibly satisfies the story's",
	},
	{ name: "linked test case", phrase: "least one linked test case" },
	{
		name: "generation-off suppression",
		phrase: "Generate manual test cases",
	},
	// Security was the section that drifted: three copies carried it, two did
	// not, and it was absent from this list — so the split was invisible here
	// while every other check was guarded. The three phrases below pin the
	// decidable checks that replaced five variants of "Authentication working",
	// which asked for an opinion the diff cannot settle.
	{ name: "no literal credentials", phrase: "introduced as a literal" },
	{ name: "injection sinks", phrase: "parameterised or validated" },
	{
		name: "no internals in user-facing errors",
		phrase: "reaches a user-facing error string",
	},
] as const;

function read(relative: string): string {
	return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("implementation-verifier persona parity", () => {
	it.each(COPIES)("%s carries every required check", (relative) => {
		const body = read(relative);
		const missing = REQUIRED.filter((r) => !body.includes(r.phrase)).map(
			(r) => r.name,
		);

		expect(
			missing,
			`${relative} is missing: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("keeps the QA check advisory in every copy", () => {
		// The QA section reports gaps; it must never be written as a blocking
		// gate. A verifier that refuses to finish because a story has no test
		// case would stop the pipeline on a judgement the model is not entitled
		// to make.
		for (const relative of COPIES) {
			expect(read(relative), relative).toMatch(/Advisory/i);
		}
	});

	it("agrees on where the report is written", () => {
		// `.cursor/agents` told the user it had saved to
		// `verification-report.md` while every other copy — and the
		// implement-tasks command that reads the result — used
		// `verifications/final-verification.md`. A report nobody looks for is
		// the same as no report, and the disagreement was silent because only
		// one copy stated the path in a completion message.
		for (const relative of COPIES) {
			const body = read(relative);
			if (!body.includes("final-verification.md")) {
				continue; // Not every copy names a path; none may name a wrong one.
			}
			expect(body, relative).not.toMatch(
				/specs\/\[[^\]]+\]\/verification-report\.md/,
			);
		}
	});

	it("never ships a report template with pre-ticked boxes", () => {
		// A template whose checkboxes arrive already `[x]` hands the model its
		// conclusion before it has looked at anything, which is how a
		// verification report says PASS without verifying. Empty boxes make the
		// verdict something the run has to produce.
		for (const relative of COPIES) {
			expect(read(relative), relative).not.toMatch(/^\s*-\s*\[x\]/im);
		}
	});

	it("names every copy that exists, so a new tool cannot be added silently", () => {
		// Guards the list above against going stale: if somebody publishes the
		// persona to a sixth tool without adding it here, every per-copy check
		// above would still pass while that copy drifted unchecked.
		//
		// Asks git rather than walking the tree — it is the same enumeration the
		// repository itself uses, so an untracked scratch copy does not fail the
		// build and a committed one cannot hide.
		const tracked = execFileSync(
			"git",
			[
				"ls-files",
				"*implementation-verifier.md",
				"*implementation-verifier.mdc",
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		)
			.split("\n")
			.map((line) => line.trim().replace(/\\/g, "/"))
			.filter(Boolean)
			.sort();

		expect(tracked).toEqual([...COPIES].sort());
	});
});
