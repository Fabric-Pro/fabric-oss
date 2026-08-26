/**
 * Migration tests for `add_pm_auto_sync_enabled_to_user_story`.
 *
 * Two test layers:
 *
 *   1. SQL-shape assertion — always runs. Reads the migration.sql file from
 *      disk and verifies the backfill UPDATE statement is present and
 *      semantically correct. Catches accidental edits like dropping the
 *      `WHERE "externalId" IS NOT NULL` clause (which would set every row
 *      to true) or misspelling the column name.
 *
 *   2. Row-count invariant — runs only when the explicit opt-in env var
 *      `RUN_PM_SYNC_BACKFILL_INVARIANT=1` is set. Asserts that EVERY row
 *      with `externalId IS NOT NULL` has `pmAutoSyncEnabled = true`.
 *      This is a global-table assertion intended for post-deploy
 *      verification against staging/production, NOT for CI unit-test runs:
 *      the shared CI test database accumulates fixtures from other suites
 *      that may legitimately create `UserStory` rows with externalId set
 *      and pmAutoSyncEnabled left at the default `false` (the migration's
 *      one-shot backfill only runs at apply-time; rows created later by
 *      tests don't go through it). Gating on a dedicated env var keeps the
 *      check available for ops without flaking the unit-test pipeline.
 *
 * The two-layer design follows the spec §9.3 fallback: if the test-db
 * harness can't replay migrations in isolation (which is true for this
 * repo — the existing `backfill-default-excalidraw.test.ts` replays the
 * data steps against an already-migrated DB but doesn't roll the schema
 * back), the structural test is sufficient to lock the SQL in CI. The
 * invariant test then serves as a manual post-deploy spot-check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";

const SHOULD_RUN_DB =
	process.env.RUN_PM_SYNC_BACKFILL_INVARIANT === "1" &&
	// Reachable-DB gate: rejects the CI/local placeholder DATABASE_URL,
	// not just an unset one (see _helpers/db-availability.ts).
	hasReachableDatabaseUrl();

function loadMigrationSql(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(here, "..", "..", "prisma", "migrations");
	const folder = readdirSync(migrationsDir).find((entry) =>
		entry.endsWith("_add_pm_auto_sync_enabled_to_user_story"),
	);
	if (!folder) {
		throw new Error(
			"Could not locate the add_pm_auto_sync_enabled_to_user_story migration folder",
		);
	}
	return readFileSync(join(migrationsDir, folder, "migration.sql"), "utf8");
}

describe("add_pm_auto_sync_enabled_to_user_story — migration shape", () => {
	const sql = loadMigrationSql();

	it("adds the pmAutoSyncEnabled column with NOT NULL DEFAULT false", () => {
		// Whitespace-tolerant: collapse runs of whitespace and lowercase the
		// alter-table fragment so a future formatting change doesn't break
		// the test. The MEANING is what we're locking.
		const normalized = sql.replace(/\s+/g, " ").toLowerCase();
		expect(normalized).toContain('alter table "user_story"');
		expect(normalized).toContain('add column "pmautosyncenabled"');
		expect(normalized).toContain("boolean not null default false");
	});

	it("backfills pmAutoSyncEnabled = true ONLY for rows with externalId set", () => {
		// The WHERE clause is the linchpin of the migration: omit it and every
		// Fabric-only feature gets opted into auto-sync, breaking the spec
		// §4.2 contract. We assert the full UPDATE shape.
		const normalized = sql.replace(/\s+/g, " ").toLowerCase();
		expect(normalized).toContain(
			'update "user_story" set "pmautosyncenabled" = true where "externalid" is not null',
		);
	});

	it("does NOT set pmAutoSyncEnabled = true unconditionally", () => {
		// Defensive check: spotting the unconditional update directly is
		// stronger than asserting the WHERE clause exists in isolation.
		const normalized = sql.replace(/\s+/g, " ").toLowerCase();
		// The unconditional pattern would be `set "pmautosyncenabled" = true;`
		// (or with a `where true` / `where 1=1`). Reject any of those.
		expect(normalized).not.toMatch(
			/set "pmautosyncenabled" = true\s*(?:;|where\s+true|where\s+1\s*=\s*1)/,
		);
	});

	it("uses the lowercase snake-case Postgres table name (matches @@map)", () => {
		// Schema's `@@map("user_story")` maps the Prisma `UserStory` model to
		// the lowercase `user_story` table. A stale draft of this migration
		// referenced "UserStory" by mistake and silently no-op'd in dev
		// against a clean DB but failed against the staging DB. Lock it.
		expect(sql).toContain('"user_story"');
		expect(sql).not.toContain('"UserStory"');
	});
});

// ---------------------------------------------------------------------------
// Row-count invariant — runs only when DATABASE_URL is set. Mirrors the
// `backfill-default-excalidraw.test.ts` opt-in pattern.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN_DB)(
	"add_pm_auto_sync_enabled_to_user_story — DB row-count invariant",
	() => {
		// Conditional import — the Prisma client opens a connection on first
		// property access. Defer the import until DATABASE_URL is confirmed.
		let db: typeof import("../../prisma/client").db;

		it("every row with externalId IS NOT NULL has pmAutoSyncEnabled = true", async () => {
			const dbModule = await import("../../prisma/client");
			db = dbModule.db;

			// Spec §11 risk #1: a regression in the migration could leave
			// some PM-linked rows with `pmAutoSyncEnabled = false`, which
			// would silently break sync for those features. The strong
			// invariant is that EVERY row with externalId IS NOT NULL has
			// pmAutoSyncEnabled=true.
			const linkedButOffCount = await db.userStory.count({
				where: {
					externalId: { not: null },
					pmAutoSyncEnabled: false,
				},
			});
			expect(linkedButOffCount).toBe(0);
		});
	},
);
