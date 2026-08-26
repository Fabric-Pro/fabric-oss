/**
 * Migration test for `reset_inert_attachment_sync_opt_ins`.
 *
 * SQL-shape assertion only, following `add_pm_auto_sync_enabled.test.ts`:
 * the repo's test harness cannot roll the schema back to replay a migration
 * in isolation, so locking the statement's shape is what CI can honestly
 * enforce. There is no row-count invariant layer here because the column
 * this migration clears has no reader — a global assertion would only
 * restate the UPDATE.
 *
 * What the shape has to protect: `Project.syncAttachments` was writable from
 * the project-settings switch while nothing acted on it, and hiding that
 * switch (fix/hide-inert-attachment-sync-toggle) leaves any stored `true`
 * with no affordance to clear. `update-project.ts` already treats exactly
 * that state as a reset on PM disconnect. So the value must be cleared for
 * EVERY project — a stray `WHERE` would preserve the opt-ins this exists to
 * discard, and would hand the future sync engine consent nobody gave it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SUFFIX = "_reset_inert_attachment_sync_opt_ins";

function loadMigrationSql(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(here, "..", "..", "prisma", "migrations");
	const folder = readdirSync(migrationsDir).find((entry) =>
		entry.endsWith(SUFFIX),
	);
	if (!folder) {
		throw new Error(`Could not locate the ${SUFFIX} migration folder`);
	}
	return readFileSync(join(migrationsDir, folder, "migration.sql"), "utf8");
}

/** Statements with comments and blank lines stripped. */
function statements(sql: string): string[] {
	return sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

describe("reset_inert_attachment_sync_opt_ins — migration shape", () => {
	const sql = loadMigrationSql();

	it("clears syncAttachments on the project table", () => {
		expect(sql).toMatch(
			/UPDATE\s+"project"\s+SET\s+"syncAttachments"\s*=\s*false/i,
		);
	});

	it("clears every opted-in project rather than a subset", () => {
		const update = statements(sql).find((s) => /^UPDATE/i.test(s));
		expect(update).toBeDefined();
		// `WHERE "syncAttachments"` is the one predicate that is safe — it
		// narrows to the rows already being set, so the result is identical
		// and the write is cheaper. Any other filter would leave opt-ins.
		const where = update?.match(/\bWHERE\b(.*)$/is)?.[1] ?? "";
		if (where.trim().length > 0) {
			expect(where).toMatch(/"syncAttachments"/);
		}
	});

	it("touches no table other than project", () => {
		for (const statement of statements(sql)) {
			expect(statement).not.toMatch(
				/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"(?!project")/i,
			);
		}
	});

	it("makes no schema change — the column and its default stay as they are", () => {
		expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
		expect(sql).not.toMatch(/\bDROP\b/i);
	});
});
