/**
 * Drift alarm for `20260909140000_sync_planning_analysis_linkedin_content_type`.
 *
 * That migration carries two paragraphs of
 * `PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY` into environments the
 * INSERT-ONLY prompt seed can never reach. A migration is frozen history, so
 * the text inside it is a point-in-time snapshot that can never be re-synced —
 * the usual reason `@repo/utils/publishing-planning-prompt` keeps key and body
 * in ONE place is precisely to stop copies like it existing.
 *
 * The copy cannot be removed, so it is pinned from the other end instead: this
 * suite reads the two dollar-quoted fragments straight out of the migration on
 * disk and checks the constant still agrees with them. Reword that paragraph in
 * the constant and this goes red, which is the moment to decide whether the
 * change needs a sync migration of its own — it will, for exactly the reason
 * the 2026-09-09 one exists.
 *
 * Deliberately NOT a whole-body pin: this catches an edit to the paragraphs the
 * migration touched, not an edit elsewhere in the body. An unrelated reword
 * still reaches fresh installs only, silently, as it does for all seven
 * publishing prompts — a general alarm for that belongs across the whole family
 * rather than bolted onto one migration.
 *
 * No database: the fragments and the constant are both text on disk, and the
 * behavioural properties of the statement (updates a pristine row, no-ops on a
 * customised one, idempotent) are properties of Postgres, not of this package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
	PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
} from "@repo/utils/publishing-planning-prompt";
import { describe, expect, it } from "vitest";

const MIGRATION_SUFFIX = "_sync_planning_analysis_linkedin_content_type";

function loadMigrationSql(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(here, "..", "..", "prisma", "migrations");
	const folder = readdirSync(migrationsDir).find((entry) =>
		entry.endsWith(MIGRATION_SUFFIX),
	);
	if (!folder) {
		throw new Error(
			`Could not locate the ${MIGRATION_SUFFIX} migration folder`,
		);
	}
	return readFileSync(join(migrationsDir, folder, "migration.sql"), "utf8");
}

/**
 * Pull one dollar-quoted fragment out of the migration by its tag. The tags are
 * `$old_types$` and `$new_types$`; the body carries no `$` of its own, so the
 * delimiters are unambiguous.
 */
function extractFragment(sql: string, tag: string): string {
	const delimiter = `$${tag}$`;
	const start = sql.indexOf(delimiter);
	if (start === -1) {
		throw new Error(`Migration has no ${delimiter} fragment`);
	}
	const contentStart = start + delimiter.length;
	const end = sql.indexOf(delimiter, contentStart);
	if (end === -1) {
		throw new Error(`Migration's ${delimiter} fragment is not closed`);
	}
	return sql.slice(contentStart, end);
}

describe("sync_planning_analysis_linkedin_content_type — pins the migration's copy of the prompt", () => {
	const sql = loadMigrationSql();
	const replaced = extractFragment(sql, "old_types");
	const replacement = extractFragment(sql, "new_types");

	it("the migration replaces something with something else", () => {
		expect(replaced.length).toBeGreaterThan(0);
		expect(replacement).not.toBe(replaced);
	});

	it("the seeded body carries the text the migration writes, exactly once", () => {
		// If this fails the constant has been reworded and deployed
		// environments — which only ever get this text from the migration —
		// now run a different prompt from a freshly-seeded one.
		expect(
			PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY.split(replacement)
				.length - 1,
		).toBe(1);
	});

	it("the seeded body no longer carries the text the migration replaces", () => {
		expect(PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY).not.toContain(
			replaced,
		);
	});

	it("running the migration's replace() against the seeded body changes nothing", () => {
		// The freshly-seeded case: the seed writes the constant, then the
		// migration runs against it. It must be a no-op, or a fresh install and
		// an upgraded one diverge on the first deploy.
		expect(
			PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY.replaceAll(
				replaced,
				replacement,
			),
		).toBe(PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY);
	});

	it("targets the prompt key the seed actually writes", () => {
		// The migration names the key as a SQL literal. Renaming the agent key
		// without a new migration would leave every deployed environment's
		// prompt untargeted and unfixable by this one.
		expect(sql).toContain(
			`p."key" = '${PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY}'`,
		);
		expect(sql).toContain(
			`b."targetKey" = '${PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY}'`,
		);
	});
});
