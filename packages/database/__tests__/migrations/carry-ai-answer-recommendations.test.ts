/**
 * Migration test for `carry_ai_answer_recommendations_into_flag_override`
 * (Fizzy #2300).
 *
 * SQL-shape assertion only, following `reset-inert-attachment-sync-opt-ins`.
 * A replay against seeded organizations needs a real database (the
 * db-integration allowlist) and was not added here; this test locks the
 * statement's shape, and CI's migrate step applies it to an empty database.
 *
 * What the shape protects:
 *   - Every organization enabled on the retired column gets a per-organization
 *     row, because the new reader resolves the registry flag and ignores the
 *     column.
 *   - A row an operator already wrote for this key is never overwritten.
 *   - The file is exactly ONE statement. Its `allow unbatched-backfill` marker
 *     suppresses the rule for the whole file, so a second statement added later
 *     would be exempted silently.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SUFFIX = "_carry_ai_answer_recommendations_into_flag_override";

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

/** Statements with comment lines and blank lines stripped. */
function statements(sql: string): string[] {
	return sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

describe("carry_ai_answer_recommendations_into_flag_override — migration shape", () => {
	const sql = loadMigrationSql();
	const body = statements(sql);
	const code = body.join(";\n");

	it("is exactly one statement, so the file-wide lint marker covers nothing else", () => {
		expect(body).toHaveLength(1);
	});

	it("inserts override rows for the registry key", () => {
		expect(body[0]).toMatch(
			/^INSERT\s+INTO\s+"organization_feature_flag_override"\s*\(\s*"key"\s*,\s*"organizationId"\s*,\s*"enabled"\s*,\s*"updatedAt"\s*,\s*"updatedBy"\s*\)/i,
		);
		expect(body[0]).toMatch(
			/SELECT\s+'AI_ANSWER_RECOMMENDATIONS'\s*,\s*"id"\s*,\s*true\s*,\s*CURRENT_TIMESTAMP\s*,\s*'migration:ai-answer-recommendations'/i,
		);
	});

	it("copies only organizations enabled on the column", () => {
		expect(body[0]).toMatch(
			/FROM\s+"organization"\s+WHERE\s+"aiAnswerRecommendationsEnabled"\s*=\s*true\s+ON\s+CONFLICT/i,
		);
	});

	it("leaves an existing row for the key untouched", () => {
		expect(body[0]).toMatch(
			/ON\s+CONFLICT\s*\(\s*"key"\s*,\s*"organizationId"\s*\)\s*DO\s+NOTHING$/i,
		);
		expect(code).not.toMatch(/\bDO\s+UPDATE\b/i);
	});

	it("makes no schema change and removes nothing, so the previous build can still read the column", () => {
		expect(code).not.toMatch(/\bALTER\b/i);
		expect(code).not.toMatch(/\bDROP\b/i);
		expect(code).not.toMatch(/\bDELETE\b/i);
		expect(code).not.toMatch(/\bUPDATE\s+"/i);
	});

	it("carries an unbatched-backfill allow marker with a reason", () => {
		expect(sql).toMatch(
			/--\s*migration-lint:\s*allow\s+unbatched-backfill\s+[-—:]+\s*\S/,
		);
	});
});
