/**
 * Migration tests for `backfill_default_excalidraw_mcp_config`.
 * These tests verify the THREE behavioral invariants of the migration's
 * data-write steps (steps 2-4 of the migration SQL file):
 * Idempotency — re-running the data steps produces zero new rows and
 * zero updates on the second pass.
 * Non-destructive dedupe — a pre-existing user-installed Excalidraw
 * row is FLIPPED in place
 * (`isManagedDefault=true`) so
 * `Diagram.mcpConfigId` references are
 * preserved.
 * Sentinel row count invariant — every `(userId,
 * organizationId|null)` tenant tuple
 * has exactly one `mcp_config` row for
 * the Excalidraw server.
 * The migration is a single.sql file applied by Prisma — the only
 * faithful way to verify it is to run the raw SQL against a real
 * Postgres. CI runs the equivalent of this via the migration's normal
 * `prisma migrate dev` apply, but a unit-test-style replay catches
 * regressions in the migration's idempotency guards specifically.
 * Environment gate: if `DATABASE_URL` is unset, the suite skips. This
 * mirrors the `rls-isolation.test.ts` pattern. CI can opt-in by setting
 * `DATABASE_URL` before invoking `pnpm --filter @repo/database test
 * __tests__/migrations/backfill-default-excalidraw.test.ts`.
 * IMPORTANT: This test reads the actual migration SQL from disk
 * (`packages/database/prisma/migrations/<ts>_backfill_default_excalidraw_mcp_config/migration.sql`)
 * and replays its data-write steps. Steps 3a/3b/4 are guarded so
 * re-running is a no-op — that's what the test locks. Step 1 (schema
 * deltas) is NOT re-applied because the columns already exist after the
 * first migrate-dev.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";

// Reachable-DB gate: rejects the CI/local placeholder DATABASE_URL, not
// just an unset one (see _helpers/db-availability.ts).
const SHOULD_RUN = hasReachableDatabaseUrl();

// Conditional import — `db` triggers a connection on first property
// access. Defer the import until inside the test runner.
let db: typeof import("../../prisma/client").db | undefined;

// Test tenant ids — namespaced so a re-run against the same DB doesn't
// stomp other suites' rows. Cleaned up in afterAll.
const TENANT = {
	standaloneUser: "test-mig-default-excalidraw-user-standalone",
	orgOwnerUser: "test-mig-default-excalidraw-user-orgowner",
	preExistingUser: "test-mig-default-excalidraw-user-preexisting",
	org: "test-mig-default-excalidraw-org-1",
};

// Step bookmarks extracted from the migration SQL so the test runs ONLY
// the data-write steps. We never re-execute the `ALTER TABLE` /
// `CREATE INDEX` lines because those columns are already in place on a
// migrated test DB.
let DATA_STEPS_SQL = "";

beforeAll(async () => {
	if (!SHOULD_RUN) {
		return;
	}

	const dbModule = await import("../../prisma/client");
	db = dbModule.db;

	const migrationSql = loadMigrationSql();
	DATA_STEPS_SQL = extractDataSteps(migrationSql);

	// Seed the test fixture: one standalone user, one user that owns an
	// org, and a pre-existing user-installed Excalidraw row for the
	// pre-existing user (non-destructive-dedupe scenario).
	const now = new Date();
	for (const userId of [
		TENANT.standaloneUser,
		TENANT.orgOwnerUser,
		TENANT.preExistingUser,
	]) {
		// `createdAt`/`updatedAt` carry no default on User, so they are
		// required. The cast this call used to carry hid the omission until
		// runtime.
		const now = new Date();
		await db!.user.upsert({
			where: { id: userId },
			update: {},
			create: {
				id: userId,
				email: `${userId}@test.local`,
				name: userId,
				emailVerified: true,
				onboardingComplete: false,
				createdAt: now,
				updatedAt: now,
			},
		});
	}

	await db!.organization.upsert({
		where: { id: TENANT.org },
		update: {},
		create: {
			id: TENANT.org,
			name: "Migration Test Org",
			createdAt: now,
		},
	});

	await db!.member.upsert({
		where: {
			organizationId_userId: {
				organizationId: TENANT.org,
				userId: TENANT.orgOwnerUser,
			},
		},
		update: {},
		create: {
			organizationId: TENANT.org,
			userId: TENANT.orgOwnerUser,
			role: "owner",
			createdAt: now,
		} as never,
	});
});

afterAll(async () => {
	if (!SHOULD_RUN || !db) {
		return;
	}
	// Clean up — order matters (mcp_config → member → user/org).
	await db.mCPConfig.deleteMany({
		where: {
			userId: {
				in: [
					TENANT.standaloneUser,
					TENANT.orgOwnerUser,
					TENANT.preExistingUser,
				],
			},
		},
	});
	await db.member.deleteMany({
		where: { organizationId: TENANT.org },
	});
	await db.organization.deleteMany({ where: { id: TENANT.org } });
	await db.user.deleteMany({
		where: {
			id: {
				in: [
					TENANT.standaloneUser,
					TENANT.orgOwnerUser,
					TENANT.preExistingUser,
				],
			},
		},
	});
});

describe.skipIf(!SHOULD_RUN)(
	"backfill_default_excalidraw_mcp_config — data-step replay",
	() => {
		// Idempotency.
		// Run the data steps twice. After run 2, the count of managed-default
		// rows for the test tenants MUST equal the count after run 1 (zero
		// new rows).

		it("re-running the data-write steps produces zero new rows on the second pass", async () => {
			// Run 1 — baseline.
			await replayDataSteps();
			const after1 = await countManagedDefaultRowsForTestTenants();

			// Run 2 — should be a no-op.
			await replayDataSteps();
			const after2 = await countManagedDefaultRowsForTestTenants();

			expect(after2).toBe(after1);
		});

		// Sentinel row count invariant.
		// Every (user, org|null) tuple must have exactly one Excalidraw
		// row after the migration. We assert it for the test tenants only.

		it("every test tenant tuple has exactly one Excalidraw mcp_config row", async () => {
			await replayDataSteps();

			const standaloneCount = await db!.mCPConfig.count({
				where: {
					userId: TENANT.standaloneUser,
					organizationId: null,
					mcpServer: { key: "excalidraw" },
				},
			});
			expect(standaloneCount).toBe(1);

			const orgCount = await db!.mCPConfig.count({
				where: {
					userId: TENANT.orgOwnerUser,
					organizationId: TENANT.org,
					mcpServer: { key: "excalidraw" },
				},
			});
			expect(orgCount).toBe(1);
		});

		// Pre-existing user-installed row is flipped in place
		// (id preserved, isManagedDefault becomes true, auth fields nulled,
		// enabled set to true).

		it("flips a pre-existing user-installed Excalidraw row in place (id preserved)", async () => {
			// Insert a pre-existing user-installed row for `preExistingUser`.
			// Note: the user's tenant row is also created by the personal
			// backfill (step 3a). The dedupe step (step 4) flips this row
			// in place because the `WHERE NOT EXISTS` guard on step 3a
			// detects it.
			const excalidrawServer = await db!.mCPServer.findFirst({
				where: { key: "excalidraw", isSystemProvided: true },
				select: { id: true },
			});
			expect(excalidrawServer).not.toBeNull();

			// Clean any leftover rows for this user first so the test is
			// hermetic.
			await db!.mCPConfig.deleteMany({
				where: { userId: TENANT.preExistingUser },
			});

			const created = await db!.mCPConfig.create({
				data: {
					mcpServerId: excalidrawServer!.id,
					userId: TENANT.preExistingUser,
					organizationId: null,
					authType: "NONE",
					enabled: false, // initially disabled so we can assert flip
					isManagedDefault: false, // initially user-installed
				},
			});

			await replayDataSteps();

			const updated = await db!.mCPConfig.findUnique({
				where: { id: created.id },
			});
			// Same row id — no deletion + reinsertion.
			expect(updated).not.toBeNull();
			expect(updated!.id).toBe(created.id);
			// Flipped to managed-default.
			expect(updated!.isManagedDefault).toBe(true);
			// Enabled is set to true by the dedupe.
			expect(updated!.enabled).toBe(true);
			// Auth type forced to NONE.
			expect(updated!.authType).toBe("NONE");
		});
	},
);

// Test infrastructure — extract the data steps from the migration SQL
// and replay them against the current DB.

function loadMigrationSql(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const migrationsDir = join(here, "..", "..", "prisma", "migrations");
	const folder = readdirSync(migrationsDir).find((entry) =>
		entry.endsWith("_backfill_default_excalidraw_mcp_config"),
	);
	if (!folder) {
		throw new Error(
			"Could not locate the backfill_default_excalidraw_mcp_config migration folder",
		);
	}
	return readFileSync(join(migrationsDir, folder, "migration.sql"), "utf8");
}

/**
 * Strip the schema-delta steps (ALTER TABLE / CREATE INDEX) from the
 * migration SQL so we replay only the idempotent data-write steps
 * (UPDATE / INSERT). Comments are preserved for readability.
 */
function extractDataSteps(sql: string): string {
	const lines = sql.split("\n");
	const kept: string[] = [];
	let inSchemaBlock = false;
	for (const line of lines) {
		const upper = line.trim().toUpperCase();
		if (
			upper.startsWith("ALTER TABLE") ||
			upper.startsWith("CREATE INDEX") ||
			upper.startsWith("CREATE UNIQUE INDEX")
		) {
			inSchemaBlock = true;
			continue;
		}
		// Schema-delta lines continue until the `;` ends the statement.
		if (inSchemaBlock) {
			if (line.includes(";")) {
				inSchemaBlock = false;
			}
			continue;
		}
		kept.push(line);
	}
	return kept.join("\n");
}

async function replayDataSteps() {
	if (!db) {
		throw new Error("db is not initialized — beforeAll did not run");
	}
	// Split on `;` followed by newline so multi-line statements stay
	// together. Filter empty fragments.
	const statements = DATA_STEPS_SQL.split(/;\s*\n/).filter(
		(s) => s.trim().length > 0,
	);
	for (const stmt of statements) {
		const sql = stmt.trim().replace(/;\s*$/, "");
		if (sql.length === 0 || sql.startsWith("--")) {
			continue;
		}
		// $executeRawUnsafe is the only way to run arbitrary SQL via
		// PrismaClient. Migration SQL is trusted (read from disk).
		await db.$executeRawUnsafe(sql);
	}
}

async function countManagedDefaultRowsForTestTenants(): Promise<number> {
	return db!.mCPConfig.count({
		where: {
			isManagedDefault: true,
			userId: {
				in: [
					TENANT.standaloneUser,
					TENANT.orgOwnerUser,
					TENANT.preExistingUser,
				],
			},
		},
	});
}
