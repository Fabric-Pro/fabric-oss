/**
 * Migration shape for `add_publishing_decision_folded_questions` (Fizzy #1988).
 *
 * Read from disk, like `add_pm_auto_sync_enabled.test.ts`: the default unit
 * run has no database, and the meaning of this migration is its SQL. The
 * migration is hand-written — `prisma migrate diff` drops `NOT NULL` on an
 * array column — so the NOT NULL is exactly what this pins.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FOLDER_SUFFIX = "_add_publishing_decision_folded_questions";

function loadMigrationSql(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(here, "..", "..", "prisma", "migrations");
	const folders = readdirSync(migrationsDir).filter((entry) =>
		entry.endsWith(FOLDER_SUFFIX),
	);
	if (folders.length !== 1) {
		throw new Error(
			`Expected exactly one ${FOLDER_SUFFIX} migration folder, found ${folders.length}`,
		);
	}
	return readFileSync(
		join(migrationsDir, folders[0] as string, "migration.sql"),
		"utf8",
	);
}

/** The SQL with `--` comments removed, whitespace folded, lowercased — `;` kept. */
function normalized(sql: string): string {
	return sql
		.split("\n")
		.map((line) => line.replace(/--.*$/, ""))
		.join("\n")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** The non-empty statements of the normalized SQL, split on `;`. */
function statements(sql: string): string[] {
	return normalized(sql)
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

describe("add_publishing_decision_folded_questions — migration shape", () => {
	const sql = loadMigrationSql();
	const all = statements(sql);

	it("is exactly one statement", () => {
		expect(all).toHaveLength(1);
	});

	it("adds the folded-question list as a required array that defaults to empty", () => {
		expect(all[0]).toContain(
			'alter table "publishing_topic_decision_entry"',
		);
		expect(all[0]).toContain(
			'add column "foldedquestions" text[] not null default array[]::text[]',
		);
	});

	it("adds the version stamp as a nullable integer, with nothing after its type", () => {
		// The version column is the statement's last clause, so `integer` must
		// be followed directly by the statement's `;`. A lookahead for
		// " not null" alone would let `INTEGER DEFAULT 0 NOT NULL` through, and
		// the migration linter accepts NOT NULL with a default.
		expect(normalized(sql)).toMatch(
			/add column "foldedquestionsversion" integer\s*;/,
		);
	});
});
