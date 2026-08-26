/**
 * The auto-draft trigger must be handed to `runInBackground`, never `void`-ed.
 *
 * `maybeAutoDraftOnStageChange` runs its eligibility query BEFORE it dispatches,
 * and all of it happens after the procedure stops awaiting. On Vercel a bare
 * floating promise is not guaranteed to finish once the response is sent
 * (`weave/lib/run-in-background.ts` says so in its own docblock), so a `void`-ed
 * call gets killed mid-query — no claim, no dispatch, no error, nothing in the
 * log. That is indistinguishable from the bug the trigger exists to fix, and it
 * only happens in production: off Vercel `waitUntil` degrades to a no-op and the
 * promise runs eagerly anyway, so no local run and no unit test of the handler's
 * behaviour would ever catch it.
 *
 * `run-in-background.ts` is a local wrapper specifically so a test can assert
 * "continuation scheduled" by mocking it. That is what this does — a source
 * check, because the failure is structural and invisible at runtime here.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(__dirname, "..", "..", "..", "..");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "__tests__") {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
			continue;
		}
		if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

const callers = walk(join(API_ROOT, "modules"))
	.map((full) => ({
		rel: full.slice(API_ROOT.length + 1).replace(/\\/g, "/"),
		source: readFileSync(full, "utf8"),
	}))
	.filter(
		(f) =>
			f.source.includes("maybeAutoDraftOnStageChange(") &&
			!f.rel.includes("lib/auto-draft-test-cases.ts"),
	);

describe("auto-draft trigger is scheduled, not floated", () => {
	it("finds the call sites (the scan must not silently pass)", () => {
		expect(callers.length).toBeGreaterThan(2);
	});

	it.each(callers.map((c) => c.rel))(
		"%s hands the trigger to runInBackground",
		(rel) => {
			const source = callers.find((c) => c.rel === rel)?.source ?? "";

			// The exact shape that loses the work in production.
			expect(
				source.includes("void maybeAutoDraftOnStageChange("),
				`${rel} calls the trigger with a bare \`void\`. On Vercel the ` +
					"eligibility query inside it can be killed when the response " +
					"flushes, so no drafting run starts and nothing is logged. " +
					"Wrap it: runInBackground(maybeAutoDraftOnStageChange({...})).",
			).toBe(false);

			expect(
				/runInBackground\(\s*maybeAutoDraftOnStageChange\(/.test(
					source,
				),
				`${rel} must wrap the trigger in runInBackground`,
			).toBe(true);

			expect(source).toContain("run-in-background");
		},
	);

	it("does not leave the dispatch double-scheduled inside the helper", () => {
		// With the caller registering the whole promise, an inner
		// `runInBackground(startAutoDraft(...))` would register a second,
		// detached lifetime and make the helper's contract ambiguous.
		const helper = readFileSync(
			join(API_ROOT, "modules/projects/lib/auto-draft-test-cases.ts"),
			"utf8",
		);
		expect(helper).toContain("await startAutoDraft(");
		expect(helper).not.toMatch(/runInBackground\(\s*startAutoDraft\(/);
	});
});
