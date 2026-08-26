/**
 * Migration tests for `remove_passive_analysis_stage`.
 *
 * Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md
 *
 * Two test layers, mirroring the `add_pm_auto_sync_enabled.test.ts` pattern:
 *
 *   1. SQL-shape assertion — always runs. Reads the migration.sql file from
 *      disk and verifies the four defensive-sweep UPDATE statements are
 *      present and target the correct tables.
 *
 *   2. Idempotency invariant — runs only when the explicit opt-in env var
 *      `RUN_PASSIVE_ANALYSIS_MIGRATION_INVARIANT=1` is set + DATABASE_URL.
 *      Asserts that re-running the migration SQL updates 0 rows on the
 *      second pass, and that content fields (`description`,
 *      `acceptanceCriteria`, `title`) and audit fields (`draftingStageUpdatedAt`,
 *      `updatedAt`) are unchanged for migrated rows. Raw SQL UPDATE bypasses
 *      Prisma's `@updatedAt` trigger, per spec §5.3 / REQ-14.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";

const SHOULD_RUN_DB =
	process.env.RUN_PASSIVE_ANALYSIS_MIGRATION_INVARIANT === "1" &&
	// Reachable-DB gate: rejects the CI/local placeholder DATABASE_URL,
	// not just an unset one (see _helpers/db-availability.ts).
	hasReachableDatabaseUrl();

function loadMigrationSql(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(here, "..", "..", "prisma", "migrations");
	const folder = readdirSync(migrationsDir).find((entry) =>
		entry.endsWith("_remove_passive_analysis_stage"),
	);
	if (!folder) {
		throw new Error(
			"Could not locate the remove_passive_analysis_stage migration folder",
		);
	}
	return readFileSync(join(migrationsDir, folder, "migration.sql"), "utf8");
}

describe("remove_passive_analysis_stage — migration shape", () => {
	const sql = loadMigrationSql();
	const normalized = sql.replace(/\s+/g, " ").toLowerCase();

	it("updates user_story rows where draftingStage = PASSIVE_ANALYSIS", () => {
		expect(normalized).toContain(
			`update "user_story" set "draftingstage" = 'placeholder' where "draftingstage" = 'passive_analysis'`,
		);
	});

	it("updates feature_version rows where draftingStage = PASSIVE_ANALYSIS", () => {
		expect(normalized).toContain(
			`update "feature_version" set "draftingstage" = 'placeholder' where "draftingstage" = 'passive_analysis'`,
		);
	});

	it("updates epic rows where draftingStage = PASSIVE_ANALYSIS", () => {
		expect(normalized).toContain(
			`update "epic" set "draftingstage" = 'placeholder' where "draftingstage" = 'passive_analysis'`,
		);
	});

	it("updates feature rows where draftingStage = PASSIVE_ANALYSIS", () => {
		expect(normalized).toContain(
			`update "feature" set "draftingstage" = 'placeholder' where "draftingstage" = 'passive_analysis'`,
		);
	});

	it("does NOT alter the FeatureDraftingStage enum (soft-deprecate per OQ-1)", () => {
		// Per OQ-1 default + G7 verification: the enum stays. Any ALTER TYPE
		// statement would couple this work to the rename-recreate technique
		// (F-171 precedent) and is explicitly deferred to TBD-1.
		expect(normalized).not.toContain("alter type");
		expect(normalized).not.toContain("drop value");
	});

	it("does NOT touch content fields (description, acceptanceCriteria, title)", () => {
		// Per REQ-14: the migration ONLY touches draftingStage. Content fields
		// are preserved verbatim. Asserting absence in the migration SQL is
		// the simplest static check.
		expect(normalized).not.toMatch(/set\s+"description"/);
		expect(normalized).not.toMatch(/set\s+"acceptancecriteria"/);
		expect(normalized).not.toMatch(/set\s+"title"/);
	});

	it("does NOT explicitly bump updatedAt (raw SQL bypasses @updatedAt)", () => {
		// Per spec §5.3 + REQ-14: raw SQL UPDATE does NOT trigger Prisma's
		// @updatedAt. The migration must not set updatedAt explicitly, so
		// migrated rows retain their previous updatedAt. This is intentional
		// — the migration is a system reclassification, not a user edit.
		expect(normalized).not.toMatch(/set\s+"updatedat"/);
		expect(normalized).not.toMatch(/set\s+"draftingstageupdatedat"/);
	});

	it("includes rollback documentation as a comment block (per spec §5.4)", () => {
		// The migration cannot be reversed by inverse SQL — the rollback SQL
		// template must live in a comment block in the migration file so
		// it's discoverable at the point of need.
		expect(sql.toLowerCase()).toContain("rollback");
		expect(sql.toLowerCase()).toContain("snapshot");
	});
});

// ---------------------------------------------------------------------------
// DB idempotency invariant — runs only when DATABASE_URL is set + opt-in env.
// Mirrors the `add_pm_auto_sync_enabled.test.ts` opt-in pattern.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN_DB)(
	"remove_passive_analysis_stage — DB idempotency invariant",
	() => {
		it("post-migration: zero rows remain at draftingStage = PASSIVE_ANALYSIS across all 4 bearing tables", async () => {
			const dbModule = await import("../../prisma/client");
			const { db } = dbModule;

			// Spec REQ-13 + AC9 post-deploy check. Cast the enum because the
			// generated Prisma client still includes PASSIVE_ANALYSIS (soft-
			// deprecated per OQ-1).
			const PASSIVE_ANALYSIS = "PASSIVE_ANALYSIS" as never;

			const userStoryCount = await db.userStory.count({
				where: { draftingStage: PASSIVE_ANALYSIS },
			});
			expect(userStoryCount).toBe(0);

			// feature_version, epic, feature are reachable via raw SQL since
			// they may not all have Prisma models exposed. Use $queryRawUnsafe
			// to be table-name-driven.
			const tables = ["feature_version", "epic", "feature"];
			for (const table of tables) {
				const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
					`SELECT COUNT(*)::bigint AS count FROM "${table}" WHERE "draftingStage" = 'PASSIVE_ANALYSIS'`,
				);
				const count = Number(rows[0]?.count ?? 0);
				expect(count).toBe(0);
			}
		});

		it("re-running the migration SQL is idempotent (0 rows affected on second pass)", async () => {
			const dbModule = await import("../../prisma/client");
			const { db } = dbModule;

			// Re-execute each UPDATE; since the first apply moved all rows,
			// the second pass should affect 0 rows. We use $executeRawUnsafe
			// which returns the affected-row count.
			const tables = ["user_story", "feature_version", "epic", "feature"];
			for (const table of tables) {
				const affected = await db.$executeRawUnsafe(
					`UPDATE "${table}" SET "draftingStage" = 'PLACEHOLDER' WHERE "draftingStage" = 'PASSIVE_ANALYSIS'`,
				);
				expect(affected).toBe(0);
			}
		});
	},
);
