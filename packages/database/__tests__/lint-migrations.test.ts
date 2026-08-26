import { describe, expect, it } from "vitest";
import {
	indexesCreatedIn,
	lintAll,
	lintMigration,
	MIGRATIONS_DIR,
	parseAllowMarkers,
	type RuleId,
	readBaseline,
	splitStatements,
	stripSqlNoise,
	tablesCreatedIn,
} from "../scripts/lint-migrations";

const EXISTING = new Set(["user", "user_story", "session"]);

function rulesFor(
	sql: string,
	preExisting: ReadonlySet<string> = EXISTING,
): RuleId[] {
	return lintMigration({
		migration: "test",
		sql,
		preExistingTables: preExisting,
	}).map((f) => f.rule);
}

describe("stripSqlNoise", () => {
	it("blanks line comments but keeps line structure", () => {
		const stripped = stripSqlNoise('-- DROP COLUMN "x"\nSELECT 1;');
		expect(stripped).not.toMatch(/DROP COLUMN/);
		expect(stripped.split("\n")).toHaveLength(2);
		expect(stripped).toMatch(/SELECT 1/);
	});

	it("blanks block comments across lines", () => {
		const stripped = stripSqlNoise(
			'/* DROP TABLE "user"\n still comment */\nSELECT 1;',
		);
		expect(stripped).not.toMatch(/DROP TABLE/);
		expect(stripped).toMatch(/SELECT 1/);
	});

	it("blanks string literals so prose in data never matches a rule", () => {
		const stripped = stripSqlNoise(
			`INSERT INTO "t" VALUES ('ALTER TABLE "user" DROP COLUMN "a"');`,
		);
		expect(stripped).not.toMatch(/DROP COLUMN/);
		expect(stripped).toMatch(/INSERT INTO/);
	});

	it("handles escaped quotes inside string literals", () => {
		const stripped = stripSqlNoise(`SELECT 'it''s fine', "realColumn";`);
		expect(stripped).toMatch(/realColumn/);
	});
});

describe("splitStatements", () => {
	it("does not split on a semicolon nested in parentheses", () => {
		const statements = splitStatements(
			"UPDATE a SET b = (SELECT 1); SELECT 2;",
		);
		expect(statements).toHaveLength(2);
	});

	it("reports the line each statement starts on", () => {
		const statements = splitStatements("SELECT 1;\n\nSELECT 2;");
		expect(statements[0].line).toBe(1);
		expect(statements[1].line).toBe(3);
	});
});

describe("tablesCreatedIn", () => {
	it("collects created tables including IF NOT EXISTS", () => {
		const created = tablesCreatedIn(
			'CREATE TABLE "a" (id text); CREATE TABLE IF NOT EXISTS "b" (id text);',
		);
		expect(created).toEqual(new Set(["a", "b"]));
	});
});

describe("indexesCreatedIn", () => {
	it("records named indexes, including UNIQUE and CONCURRENTLY forms", () => {
		expect(
			indexesCreatedIn(
				`CREATE INDEX "plain" ON "user" ("id");
CREATE UNIQUE INDEX CONCURRENTLY "uniq" ON "user" ("email");`,
			),
		).toEqual(new Set(["plain", "uniq"]));
	});

	it("ignores the unnamed form, which no later DROP INDEX can target", () => {
		expect(indexesCreatedIn('CREATE INDEX ON "user" ("id");')).toEqual(
			new Set(),
		);
	});
});

describe("parseAllowMarkers", () => {
	it("accepts a marker with a reason", () => {
		expect(
			parseAllowMarkers(
				"-- migration-lint: allow blocking-index — table is empty in every env",
			),
		).toEqual(new Set(["blocking-index"]));
	});

	it("ignores a marker with no reason, so the escape hatch cannot be used silently", () => {
		expect(
			parseAllowMarkers("-- migration-lint: allow blocking-index"),
		).toEqual(new Set());
	});

	it("does not let the rule id absorb the separator when the reason is missing", () => {
		// Regression: the id group used to backtrack, parsing this as rule
		// `blocking` with `-index` read as separator-plus-reason.
		expect(
			parseAllowMarkers("-- migration-lint: allow blocking-index"),
		).not.toContain("blocking");
	});

	it("drops an unrecognised rule id rather than creating a phantom suppression", () => {
		expect(
			parseAllowMarkers(
				"-- migration-lint: allow not-a-real-rule — because",
			),
		).toEqual(new Set());
	});

	it("accepts every documented rule id", () => {
		expect(
			parseAllowMarkers(
				"-- migration-lint: allow unbatched-backfill — batched job follows",
			),
		).toEqual(new Set(["unbatched-backfill"]));
	});
});

describe("blocking-index", () => {
	it("flags a plain index on a pre-existing table", () => {
		expect(
			rulesFor('CREATE INDEX "i" ON "user_story"("projectId");'),
		).toContain("blocking-index");
	});

	it("accepts CONCURRENTLY", () => {
		expect(
			rulesFor(
				'CREATE INDEX CONCURRENTLY "i" ON "user_story"("projectId");',
			),
		).not.toContain("blocking-index");
	});

	it("accepts an index on a table created in the same migration", () => {
		const sql =
			'CREATE TABLE "fresh" (id text);\nCREATE INDEX "i" ON "fresh"(id);';
		expect(rulesFor(sql)).not.toContain("blocking-index");
	});

	it("flags a UNIQUE index too", () => {
		expect(
			rulesFor('CREATE UNIQUE INDEX "i" ON "user"("email");'),
		).toContain("blocking-index");
	});
});

describe("unbatched-backfill", () => {
	it("flags an UPDATE ... FROM over a pre-existing table", () => {
		const sql = `UPDATE "user" u SET "lastSeenAt" = s.max FROM (SELECT "userId", MAX("updatedAt") AS max FROM "session" GROUP BY "userId") s WHERE u.id = s."userId";`;
		expect(rulesFor(sql)).toContain("unbatched-backfill");
	});

	it("flags an UPDATE with no WHERE at all", () => {
		expect(rulesFor('UPDATE "user" SET "flag" = true;')).toContain(
			"unbatched-backfill",
		);
	});

	it("flags a subquery-driven predicate", () => {
		expect(
			rulesFor(
				'UPDATE "user" SET "a" = 1 WHERE id IN (SELECT id FROM "session");',
			),
		).toContain("unbatched-backfill");
	});

	it("accepts a single-row update keyed by a literal", () => {
		expect(
			rulesFor(`UPDATE "user" SET "a" = 1 WHERE "key" = 'fixed-key';`),
		).not.toContain("unbatched-backfill");
	});

	it("accepts a backfill of a table created in the same migration", () => {
		const sql =
			'CREATE TABLE "fresh" (id text);\nUPDATE "fresh" SET id = \'x\';';
		expect(rulesFor(sql)).not.toContain("unbatched-backfill");
	});

	it("flags an unqualified DELETE", () => {
		expect(rulesFor('DELETE FROM "session";')).toContain(
			"unbatched-backfill",
		);
	});
});

describe("column-shape rules", () => {
	it("flags ADD COLUMN NOT NULL without a default", () => {
		expect(
			rulesFor('ALTER TABLE "user" ADD COLUMN "a" TEXT NOT NULL;'),
		).toContain("not-null-without-default");
	});

	it("accepts ADD COLUMN NOT NULL when a default is supplied", () => {
		expect(
			rulesFor(
				`ALTER TABLE "user" ADD COLUMN "a" TEXT NOT NULL DEFAULT 'x';`,
			),
		).not.toContain("not-null-without-default");
	});

	it("accepts a plain nullable ADD COLUMN — the expand-safe shape", () => {
		expect(
			rulesFor(
				'ALTER TABLE "user" ADD COLUMN "lastSeenAt" TIMESTAMP(3);',
			),
		).toEqual([]);
	});

	it("flags a bare SET NOT NULL", () => {
		expect(
			rulesFor('ALTER TABLE "user" ALTER COLUMN "a" SET NOT NULL;'),
		).toContain("bare-set-not-null");
	});

	it("flags a rename", () => {
		expect(
			rulesFor('ALTER TABLE "user" RENAME COLUMN "a" TO "b";'),
		).toContain("rename-in-place");
	});

	it("flags a type change", () => {
		expect(
			rulesFor('ALTER TABLE "user" ALTER COLUMN "a" TYPE BIGINT;'),
		).toContain("type-change");
	});
});

describe("destructive-without-marker", () => {
	it("flags DROP COLUMN", () => {
		expect(rulesFor('ALTER TABLE "user" DROP COLUMN "a";')).toContain(
			"destructive-without-marker",
		);
	});

	it("flags DROP TABLE on a pre-existing table", () => {
		expect(rulesFor('DROP TABLE "session";')).toContain(
			"destructive-without-marker",
		);
	});

	it("clears once an explicit marker with a reason is present", () => {
		const sql = `-- migration-lint: allow destructive-without-marker — expand shipped two releases ago\nALTER TABLE "user" DROP COLUMN "a";`;
		expect(rulesFor(sql)).toEqual([]);
	});

	it("does not flag dropping a table this migration created", () => {
		expect(
			rulesFor('CREATE TABLE "tmp" (id text);\nDROP TABLE "tmp";'),
		).toEqual([]);
	});
});

/**
 * A statement is not always one command. These are the shapes that slipped
 * through an earlier version which anchored every rule at the start of the
 * statement and ignored dollar-quoting — all three occur in this repo's real
 * migration history.
 */
describe("statements that are not a single command", () => {
	it("finds DDL inside a DO $$ ... $$ block", () => {
		const sql = `DO $$
BEGIN
    ALTER TABLE "user" ALTER COLUMN "a" SET NOT NULL;
EXCEPTION
    WHEN others THEN NULL;
END $$;`;
		expect(rulesFor(sql)).toContain("bare-set-not-null");
	});

	it("keeps a dollar-quoted body as one statement rather than splitting on its inner semicolons", () => {
		const statements = splitStatements(
			"DO $$ BEGIN a; b; END $$;\nSELECT 1;",
		);
		expect(statements).toHaveLength(2);
		expect(statements[0].text).toContain("END $$");
	});

	it("handles a tagged dollar quote", () => {
		const sql = `DO $mig$ BEGIN ALTER TABLE "user" DROP COLUMN "a"; END $mig$;`;
		expect(rulesFor(sql)).toContain("destructive-without-marker");
	});

	it("resolves a schema-qualified table to the table, not the schema", () => {
		expect(
			rulesFor('ALTER TABLE public."user" DROP COLUMN "a";'),
		).toContain("destructive-without-marker");
		expect(
			rulesFor('CREATE INDEX "i" ON public."user_story"("projectId");'),
		).toContain("blocking-index");
	});

	it("attributes each ALTER clause to its own table", () => {
		// First table is new (empty, safe), second is pre-existing.
		const sql = `CREATE TABLE "fresh" (id text);
ALTER TABLE "fresh" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "user" ALTER COLUMN "a" SET NOT NULL;`;
		expect(
			rulesFor(sql).filter((r) => r === "bare-set-not-null"),
		).toHaveLength(1);
	});

	it("flags an INSERT INTO ... SELECT backfill over a pre-existing table", () => {
		expect(
			rulesFor(
				'INSERT INTO "user" ("id") SELECT "userId" FROM "session";',
			),
		).toContain("unbatched-backfill");
	});

	it("does not flag a plain literal INSERT", () => {
		expect(rulesFor(`INSERT INTO "user" ("id") VALUES ('x');`)).toEqual([]);
	});
});

/**
 * Each command in a multi-command statement is judged on its own text. Before
 * commands were bounded, a rule reading "does this have a WHERE?" scanned to the
 * end of the statement, so one command's clause answered for another's.
 */
describe("commands do not bleed into each other", () => {
	it("still flags an unqualified UPDATE when a later command has a WHERE", () => {
		const sql = `DO $$ BEGIN UPDATE "user" SET "flag"=true; UPDATE "user" SET "other"=1 WHERE "id"='x'; END $$;`;
		expect(rulesFor(sql)).toContain("unbatched-backfill");
	});

	it("does not flag a literal INSERT because an unrelated SELECT follows it", () => {
		const sql = `DO $$ BEGIN INSERT INTO "user" ("id") VALUES ('x'); PERFORM 1 FROM (SELECT 1) t; END $$;`;
		expect(rulesFor(sql)).toEqual([]);
	});
});

describe("unvalidated-constraint", () => {
	it("flags a foreign key added to a pre-existing table", () => {
		expect(
			rulesFor(
				'ALTER TABLE "public"."user" ADD CONSTRAINT "fk1" FOREIGN KEY ("orgId") REFERENCES "org"("id");',
			),
		).toContain("unvalidated-constraint");
	});

	it("accepts a foreign key added NOT VALID", () => {
		expect(
			rulesFor(
				'ALTER TABLE "user" ADD CONSTRAINT "fk1" FOREIGN KEY ("orgId") REFERENCES "org"("id") NOT VALID;',
			),
		).not.toContain("unvalidated-constraint");
	});

	it("flags a CHECK without NOT VALID and accepts one with it", () => {
		expect(
			rulesFor('ALTER TABLE "user" ADD CONSTRAINT "c" CHECK ("a" > 0);'),
		).toContain("unvalidated-constraint");
		expect(
			rulesFor(
				'ALTER TABLE "user" ADD CONSTRAINT "c" CHECK ("a" > 0) NOT VALID;',
			),
		).not.toContain("unvalidated-constraint");
	});

	it("flags PRIMARY KEY and UNIQUE even with NOT VALID, which Postgres does not accept for them", () => {
		expect(
			rulesFor(
				'ALTER TABLE "user" ADD CONSTRAINT "pk" PRIMARY KEY ("id");',
			),
		).toContain("unvalidated-constraint");
		expect(
			rulesFor(
				'ALTER TABLE "user" ADD CONSTRAINT "u" UNIQUE ("email") NOT VALID;',
			),
		).toContain("unvalidated-constraint");
	});

	it("stays quiet on a table created in the same migration — the common Prisma shape", () => {
		const sql = `CREATE TABLE "fresh" ("id" TEXT NOT NULL, "orgId" TEXT NOT NULL);
ALTER TABLE "fresh" ADD CONSTRAINT "fk1" FOREIGN KEY ("orgId") REFERENCES "org"("id");`;
		expect(rulesFor(sql)).toEqual([]);
	});
});

describe("full-table hazards", () => {
	it("flags TRUNCATE on a pre-existing table", () => {
		expect(rulesFor('TRUNCATE TABLE "user";')).toContain(
			"destructive-without-marker",
		);
	});

	it("tracks a table created UNLOGGED, so later migrations know it exists", () => {
		expect(
			tablesCreatedIn('CREATE UNLOGGED TABLE "staging" (id text);'),
		).toEqual(new Set(["staging"]));
	});

	it("flags a pre-existing table anywhere in a DROP TABLE list, not only first", () => {
		expect(rulesFor('DROP TABLE "brand_new", "session";')).toContain(
			"destructive-without-marker",
		);
	});

	it("flags a pre-existing table anywhere in a TRUNCATE list", () => {
		expect(rulesFor('TRUNCATE "brand_new", "session";')).toContain(
			"destructive-without-marker",
		);
	});

	it("does not read a column list as a table list", () => {
		// The comma after `ADD COLUMN "a" TEXT` starts a column, not a table —
		// only TRUNCATE and DROP TABLE take a target list.
		expect(
			rulesFor(
				'CREATE TABLE "fresh" (id text);\nALTER TABLE "fresh" ADD COLUMN "a" TEXT, ADD COLUMN "session" TEXT;',
			),
		).toEqual([]);
	});

	it("accepts UNIQUE USING INDEX, which adopts an existing index rather than building one", () => {
		expect(
			rulesFor(
				'ALTER TABLE "user" ADD CONSTRAINT "u" UNIQUE USING INDEX "existing_idx";',
			),
		).not.toContain("unvalidated-constraint");
	});

	it("checks DEFAULT per added column, not once for the whole clause", () => {
		expect(
			rulesFor(
				`ALTER TABLE "user" ADD COLUMN "a" TEXT NOT NULL, ADD COLUMN "b" TEXT NOT NULL DEFAULT 'x';`,
			),
		).toContain("not-null-without-default");
	});
});

/**
 * Synthetic fixtures prove the rules fire; these prove they fire on the real
 * migration history, which is where they have to work. Both named migrations
 * are the concrete cases that motivated the rules.
 */
describe("against the real migration history", () => {
	it("catches the unbatched backfill and the blocking index that shipped", () => {
		const findings = lintAll(MIGRATIONS_DIR, new Set());
		const ruleFor = (prefix: string): RuleId[] =>
			findings
				.filter((f) => f.migration.startsWith(prefix))
				.map((f) => f.rule);

		expect(ruleFor("20260723120000_add_user_last_seen_at")).toContain(
			"unbatched-backfill",
		);
		expect(
			ruleFor("20260722150000_add_user_story_project_priority_index"),
		).toContain("blocking-index");
	});

	it("is quiet once the baseline grandfathers history, so the gate starts green", () => {
		expect(lintAll(MIGRATIONS_DIR, readBaseline())).toEqual([]);
	});
});

describe("findings carry actionable context", () => {
	it("reports rule, line and the offending statement", () => {
		const findings = lintMigration({
			migration: "20260101000000_example",
			sql: '\n\nCREATE INDEX "i" ON "user_story"("projectId");',
			preExistingTables: EXISTING,
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			migration: "20260101000000_example",
			rule: "blocking-index",
			line: 3,
		});
		expect(findings[0].statement).toContain("CREATE INDEX");
		expect(findings[0].message).toMatch(/CONCURRENTLY/);
	});
});

describe("drop-index", () => {
	it("flags a blocking DROP INDEX on an index it did not create", () => {
		const rules = rulesFor('DROP INDEX "some_legacy_key";');
		expect(rules).toContain("blocking-index");
		expect(rules).toContain("destructive-without-marker");
	});

	it("still demands the contract marker when the drop IS concurrent", () => {
		// CONCURRENTLY answers the lock hazard, not the contract-phase one:
		// the object is gone either way, and whether that is safe depends on
		// the rollout, which only a human can attest to.
		const rules = rulesFor('DROP INDEX CONCURRENTLY "some_legacy_key";');
		expect(rules).not.toContain("blocking-index");
		expect(rules).toContain("destructive-without-marker");
	});

	it("reads IF EXISTS without losing the index name", () => {
		expect(
			rulesFor('DROP INDEX CONCURRENTLY IF EXISTS "some_legacy_key";'),
		).toContain("destructive-without-marker");
	});

	it("stays quiet on an index created and dropped in the same migration", () => {
		// Nothing outside this file ever saw it, so neither rule applies.
		const sql = `CREATE INDEX CONCURRENTLY "tmp_idx" ON "user" ("id");
DROP INDEX CONCURRENTLY "tmp_idx";`;
		expect(rulesFor(sql)).toEqual([]);
	});

	it("honours the allow marker, like every other rule", () => {
		const sql = `-- migration-lint: allow destructive-without-marker — expand shipped two releases ago
DROP INDEX CONCURRENTLY "some_legacy_key";`;
		expect(rulesFor(sql)).toEqual([]);
	});

	it("reads every index in a DROP INDEX target list, not only the first", () => {
		// `DROP INDEX a, b;` is valid Postgres. Reading only the first name
		// would clear a statement whose contract-phase target happened not to
		// be written first — the same bug DROP TABLE's target list already
		// carries a comment about. Here the FIRST name is created in this very
		// migration and the second is not, so a first-name-only reader reports
		// nothing.
		const sql = `CREATE INDEX CONCURRENTLY "tmp_idx" ON "user" ("id");
DROP INDEX "tmp_idx", "some_legacy_key";`;
		expect(rulesFor(sql)).toContain("destructive-without-marker");
	});

	it("does not read a DROP INDEX inside a comment as a statement", () => {
		// The one non-baselined migration that mentions DROP INDEX does so only
		// in prose. This is load-bearing, not decorative: the raw pattern DOES
		// match that sentence (it reads `that` as the index name), so
		// stripSqlNoise is the only thing keeping it invisible.
		expect(
			rulesFor(
				"-- then DROP INDEX that name before re-running\nSELECT 1;",
			),
		).toEqual([]);
	});
});
