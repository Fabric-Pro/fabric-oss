/**
 * `ProjectUserFunctionTag` has exactly ONE writer module (Fizzy #2264, spec
 * §5.4).
 *
 * The version trigger corrects a forgetful writer rather than rejecting it, so
 * a fifth writer added elsewhere would silently work — its confirmations would
 * behave, but it would bypass the no-op exemption, the row lock and the
 * confirmation-clearing rule that live in `function-tags.ts`. The choke point
 * and the per-writer tests cannot catch that: neither can fail for a write path
 * that does not exist yet. This can.
 *
 * SCOPE, so nobody reads this as repo-wide: it walks `prisma/queries/` only,
 * and matches the Prisma model accessor by name. A writer added in
 * `packages/api`, a Temporal activity, or a raw `UPDATE "project_user_function_tag"`
 * in SQL is invisible to it. Widening the walk to the whole repository is
 * possible but would scan tens of thousands of files on every unit-test run;
 * the tree is clean today, and the layer that holds regardless of where a
 * writer lives is the database trigger, not this file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `__tests__` -> `projects` -> `queries`. Two levels, not three: a third
// lands on `prisma/`, which sweeps the generated client and the seed scripts
// and reports an offender that is not one.
const QUERIES_ROOT = path.resolve(__dirname, "../..");
const ALLOWED = path.join("projects", "function-tags.ts");
const WRITE =
	/projectUserFunctionTag\s*\.\s*(update|updateMany|upsert|create|createMany|delete|deleteMany)/;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			return entry === "__tests__" ? [] : walk(full);
		}
		return full.endsWith(".ts") ? [full] : [];
	});
}

describe("ProjectUserFunctionTag writer guard", () => {
	it("only function-tags.ts writes the table", () => {
		const offenders = walk(QUERIES_ROOT)
			.filter((f) => !f.endsWith(ALLOWED))
			.filter((f) => WRITE.test(readFileSync(f, "utf8")));

		expect(offenders).toEqual([]);
	});

	it("the guard can actually see a writer (positive control)", () => {
		// Without this, a broken regex or a wrong root makes the check above
		// pass by finding nothing anywhere — the failure mode it exists to
		// prevent, reproduced in the checker itself.
		expect(
			WRITE.test("await db.projectUserFunctionTag.update({ where })"),
		).toBe(true);
		expect(
			WRITE.test(readFileSync(path.join(QUERIES_ROOT, ALLOWED), "utf8")),
		).toBe(true);
	});
});
