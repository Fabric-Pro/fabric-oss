/**
 * The migrations behind git-native coding-instructions checkouts (Fizzy
 * #2878), pinned at the SQL the deploy runs and at the datamodel they must
 * match.
 *
 * The repository URL index is a single-statement `CONCURRENTLY` build: the
 * integration table is populated and a plain build would hold a write lock on
 * it, and a concurrent build cannot run inside the transaction Prisma wraps a
 * multi-statement migration in. No `IF NOT EXISTS`: after a failed concurrent
 * build the clause would skip the rebuild and record the migration as applied
 * over an invalid index.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MIGRATIONS_DIR,
	splitStatements,
	stripSqlNoise,
} from "../scripts/lint-migrations";

const SCHEMA = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

function statementsOf(migration: string): string[] {
	return splitStatements(
		stripSqlNoise(
			readFileSync(
				join(MIGRATIONS_DIR, migration, "migration.sql"),
				"utf8",
			),
		),
	).map((statement) => statement.text.trim());
}

function modelBlock(name: string): string {
	const start = SCHEMA.indexOf(`model ${name} {`);
	expect(start).toBeGreaterThanOrEqual(0);
	return SCHEMA.slice(start, SCHEMA.indexOf("\n}\n", start));
}

describe("automatic sync on by default", () => {
	const MIGRATION = "20261002141000_instruction_sync_automatic_default_on";

	it("is the datamodel's default, so a row inserted without the column reads true", () => {
		expect(modelBlock("ProjectInstructionRepositorySync")).toMatch(
			/\n\s*automatic\s+Boolean\s+@default\(true\)/,
		);
	});

	it("changes only the column default: no backfill of rows that stored false", () => {
		expect(statementsOf(MIGRATION)).toEqual([
			'ALTER TABLE "project_instruction_repository_sync" ALTER COLUMN "automatic" SET DEFAULT true',
		]);
	});
});

describe("the repository URL index", () => {
	const MIGRATION = "20261002140000_project_repository_integration_url_idx";

	it("is declared on the integration model, so the datamodel matches the replayed chain", () => {
		expect(modelBlock("ProjectRepositoryIntegration")).toContain(
			"@@index([repositoryUrl])",
		);
	});

	it("is built concurrently, alone, with the name Prisma derives", () => {
		const statements = statementsOf(MIGRATION);

		expect(statements).toHaveLength(1);
		expect(statements[0]).toBe(
			'CREATE INDEX CONCURRENTLY "project_repository_integration_repositoryUrl_idx" ON "project_repository_integration"("repositoryUrl")',
		);
	});
});
