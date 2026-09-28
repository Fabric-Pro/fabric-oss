/**
 * Scope guard for the Glossy editions migration (Fizzy #2589).
 *
 * The migration may only CREATE its own tables and hang indexes, foreign keys
 * and CHECK constraints off them. Prisma's generator also emits statements for
 * pre-existing drift between schema.prisma and hand-authored migrations
 * (dropped foreign keys, dropped defaults, index renames), and one of those
 * slipping in would alter a live table. So the file is split into statements
 * and every statement must match an allowed shape; anything else — DML, DROP,
 * GRANT, RENAME, ALTER TYPE, CREATE TABLE … AS/LIKE/INHERITS, or a reference
 * to any relation other than the named parents — fails.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripSqlNoise } from "../scripts/lint-migrations";

const MIGRATIONS_DIR = join(__dirname, "../prisma/migrations");

/** Pre-existing relations a Glossy foreign key may reference. */
const ALLOWED_PARENTS = new Set([
	"project",
	"project_document",
	"organization",
	"user",
]);

const EXPECTED_TABLES = [
	"glossy_edition",
	"glossy_build",
	"glossy_visual_decision",
	"glossy_segment_cache",
	"project_recipient_brand",
	"organization_brand_kit",
];

/**
 * Split SQL into statements with comments and string literals blanked out, so
 * neither prose nor a CHECK's literal values can hide or fake a keyword.
 */
function statements(sql: string): string[] {
	return stripSqlNoise(sql)
		.split(";")
		.map((statement) => statement.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

/** Whether `body` has a comma outside any parentheses (a second action). */
function hasTopLevelComma(body: string): boolean {
	let depth = 0;
	for (const ch of body) {
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
		} else if (ch === "," && depth === 0) {
			return true;
		}
	}
	return false;
}

/** Every violation in a migration; empty when it stays in scope. */
function glossyMigrationViolations(sql: string): string[] {
	const all = statements(sql);
	const created = new Set<string>();
	for (const statement of all) {
		const match = statement.match(/^CREATE TABLE "([a-z_]+)" \(/);
		if (match) {
			created.add(match[1]);
		}
	}

	const violations: string[] = [];
	for (const statement of all) {
		const fail = (why: string) =>
			violations.push(`${why}: ${statement.slice(0, 120)}`);

		if (/^CREATE TABLE /.test(statement)) {
			if (!/^CREATE TABLE "[a-z_]+" \(.*\)$/.test(statement)) {
				fail("CREATE TABLE is not a plain column list");
			} else if (
				/\b(AS|LIKE|INHERITS|REFERENCES|SELECT|PARTITION)\b/i.test(
					statement,
				)
			) {
				fail("CREATE TABLE copies, inherits or references a relation");
			}
			continue;
		}

		const index = statement.match(
			/^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)" ?\((.*)\)$/,
		);
		if (index) {
			if (!created.has(index[1])) {
				fail(`index on pre-existing table "${index[1]}"`);
			} else if (/\bSELECT\b/i.test(statement)) {
				fail("index expression reads a relation");
			}
			continue;
		}

		const constraint = statement.match(
			/^ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "[^"]+" (FOREIGN KEY|CHECK) (.*)$/,
		);
		if (constraint) {
			const [, table, , body] = constraint;
			if (!created.has(table)) {
				fail(`constraint on pre-existing table "${table}"`);
				continue;
			}
			if (hasTopLevelComma(body)) {
				fail("ALTER TABLE carries more than one action");
				continue;
			}
			if (/\b(SELECT|DROP|RENAME|ALTER)\b/i.test(body)) {
				fail("constraint body reaches beyond its table");
				continue;
			}
			for (const ref of body.matchAll(/REFERENCES "([a-z_]+)"/g)) {
				if (!created.has(ref[1]) && !ALLOWED_PARENTS.has(ref[1])) {
					fail(`foreign key to non-allowlisted relation "${ref[1]}"`);
				}
			}
			continue;
		}

		fail("statement shape not allowed");
	}
	return violations;
}

function glossyMigration(): { name: string; sql: string } {
	const folders = readdirSync(MIGRATIONS_DIR).filter((name) =>
		name.endsWith("_glossy_editions"),
	);
	expect(folders).toHaveLength(1);
	const name = folders[0];
	return {
		name,
		sql: readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
	};
}

describe("Glossy editions migration scope", () => {
	const { sql } = glossyMigration();

	it("stays within its own tables", () => {
		expect(glossyMigrationViolations(sql)).toEqual([]);
	});

	it("creates exactly the six Glossy tables", () => {
		const created = statements(sql)
			.map(
				(statement) =>
					statement.match(/^CREATE TABLE "([a-z_]+)"/)?.[1],
			)
			.filter(Boolean);
		expect(created.sort()).toEqual([...EXPECTED_TABLES].sort());
	});

	it("never mentions BackgroundJob or any enum type", () => {
		const code = stripSqlNoise(sql);
		expect(code).not.toMatch(/background_job|BackgroundJob/i);
		expect(code).not.toMatch(/\bTYPE\b/);
	});

	it("carries the hand-added CHECK constraints", () => {
		const flat = sql.replace(/\s+/g, " ");
		for (const name of [
			"glossy_build_status_check",
			"glossy_build_building_liveness_check",
			"glossy_edition_published_pair_check",
			"glossy_visual_decision_decision_check",
			"glossy_visual_decision_accepted_hash_check",
			"glossy_segment_cache_kind_check",
			"project_recipient_brand_version_check",
			"project_recipient_brand_logo_key_check",
			"organization_brand_kit_accent_colors_check",
			"organization_brand_kit_guidance_check",
		]) {
			expect(flat).toContain(`ADD CONSTRAINT "${name}" CHECK`);
		}
	});

	it("gives every project table a non-null organizationId and projectId, and no userId", () => {
		for (const table of EXPECTED_TABLES.filter(
			(name) => name !== "organization_brand_kit",
		)) {
			const create = statements(sql).find((statement) =>
				statement.startsWith(`CREATE TABLE "${table}"`),
			);
			expect(create).toContain('"organizationId" TEXT NOT NULL');
			expect(create).toContain('"projectId" TEXT NOT NULL');
			expect(create).not.toContain('"userId"');
		}
	});
});

describe("Glossy migration scope validator rejects out-of-scope statements", () => {
	const base = `CREATE TABLE "glossy_edition" ("id" TEXT NOT NULL, CONSTRAINT "glossy_edition_pkey" PRIMARY KEY ("id"));\n`;

	it("accepts the allowed shapes", () => {
		expect(
			glossyMigrationViolations(
				`${base}
				-- a comment mentioning DROP TABLE "project" is fine
				CREATE UNIQUE INDEX "glossy_edition_x_key" ON "glossy_edition"("id");
				ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_p_fkey" FOREIGN KEY ("id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
				ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_c" CHECK ("id" IN ('DROP', 'GRANT'));`,
			),
		).toEqual([]);
	});

	it.each([
		["DML insert", `INSERT INTO "glossy_edition" ("id") VALUES ('x');`],
		["DML update", `UPDATE "project" SET "name" = 'x';`],
		["DML delete", `DELETE FROM "project_document";`],
		["DROP table", `DROP TABLE "project";`],
		[
			"DROP index",
			`DROP INDEX "public"."publishing_topic_id_project_key";`,
		],
		[
			"DROP constraint",
			`ALTER TABLE "public"."publishing_topic_draft" DROP CONSTRAINT "publishing_topic_draft_topic_project_fkey";`,
		],
		[
			"DROP DEFAULT on an existing column",
			`ALTER TABLE "project_context" ALTER COLUMN "ownerKey" DROP DEFAULT;`,
		],
		["GRANT", `GRANT SELECT ON "glossy_edition" TO fabric_app;`],
		["RENAME table", `ALTER TABLE "glossy_edition" RENAME TO "x";`],
		[
			"RENAME index",
			`ALTER INDEX "member_user_idx" RENAME TO "member_userId_idx";`,
		],
		["ALTER TYPE", `ALTER TYPE "BackgroundJobKind" ADD VALUE 'GLOSSY';`],
		[
			"CREATE TABLE AS SELECT",
			`CREATE TABLE "copy" AS SELECT * FROM "project";`,
		],
		["CREATE TABLE LIKE", `CREATE TABLE "copy" (LIKE "project");`],
		[
			"CREATE TABLE INHERITS",
			`CREATE TABLE "child" ("id" TEXT NOT NULL) INHERITS ("project");`,
		],
		[
			"inline REFERENCES",
			`CREATE TABLE "child" ("id" TEXT NOT NULL REFERENCES "member"("id"));`,
		],
		[
			"index on a pre-existing table",
			`CREATE INDEX "mcp_server_default_enabled_idx" ON "mcp_server"("defaultEnabled");`,
		],
		[
			"constraint on a pre-existing table",
			`ALTER TABLE "project" ADD CONSTRAINT "x" CHECK ("id" <> '');`,
		],
		[
			"foreign key to a non-allowlisted relation",
			`ALTER TABLE "glossy_edition" ADD CONSTRAINT "x_fkey" FOREIGN KEY ("id") REFERENCES "member"("id");`,
		],
		[
			"a second action smuggled into ADD CONSTRAINT",
			`ALTER TABLE "glossy_edition" ADD CONSTRAINT "x" CHECK ("id" <> ''), DROP COLUMN "id";`,
		],
		["ADD COLUMN", `ALTER TABLE "glossy_edition" ADD COLUMN "extra" TEXT;`],
		["function or DO block", "DO $$ BEGIN PERFORM 1; END $$;"],
	])("%s", (_label, statement) => {
		expect(glossyMigrationViolations(`${base}${statement}`)).not.toEqual(
			[],
		);
	});
});
