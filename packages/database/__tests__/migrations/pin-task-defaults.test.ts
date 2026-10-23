import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";

const sql = readFileSync(
	join(
		__dirname,
		"../../prisma/migrations/20261021180000_pin_task_defaults_on_provider_connections/migration.sql",
	),
	"utf8",
);

// A real Postgres is needed to prove the backfill under FORCE RLS. The
// isolated schema and role are removed even when a migration assertion fails.
describe.skipIf(!hasReachableDatabaseUrl())(
	"provider snapshot migration",
	() => {
		it("freezes live MEDIUM text rows for both owners, captures provider-less fallbacks and null slots, and removes its RLS policies", async () => {
			const client = new Client({
				connectionString: process.env.DATABASE_URL,
			});
			const name = `example_pinned_${randomUUID().replaceAll("-", "")}`;
			const role = `${name}_owner`;
			await client.connect();
			try {
				await client.query(
					`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`,
				);
				await client.query(`GRANT "${role}" TO CURRENT_USER`);
				await client.query(
					`CREATE SCHEMA "${name}" AUTHORIZATION "${role}"`,
				);
				await client.query(`SET ROLE "${role}"`);
				await client.query(`SET search_path TO "${name}"`);
				await client.query(`
    CREATE TABLE ai_model (id TEXT PRIMARY KEY, "canonicalName" TEXT NOT NULL);
    CREATE TABLE ai_task_model_default (id TEXT PRIMARY KEY, provider TEXT, "taskType" TEXT, complexity TEXT, priority INTEGER, "modelId" TEXT REFERENCES ai_model(id));
    INSERT INTO ai_model VALUES ('old', 'example-live-old'), ('other', 'example-other'), ('fallback', 'example-fallback');
    INSERT INTO ai_task_model_default VALUES
     ('z-chat', 'OPENAI_DIRECT', 'CHAT', 'MEDIUM', 100, 'old'),
     ('a-chat', 'ANTHROPIC_DIRECT', 'CHAT', 'MEDIUM', 100, 'other'),
     ('complex-chat', 'OPENAI_DIRECT', 'CHAT', 'COMPLEX', 100, 'other'),
     ('a-reasoning', 'ANTHROPIC_DIRECT', 'REASONING', 'MEDIUM', 100, 'fallback'),
     ('z-reasoning', 'ANTHROPIC_DIRECT', 'REASONING', 'MEDIUM', 100, 'other'),
     ('decision', 'OPENAI_DIRECT', 'DECISION', 'MEDIUM', 100, 'other'),
     ('embedding', 'OPENAI_DIRECT', 'EMBEDDING', 'MEDIUM', 100, 'other'),
     ('null-simple', NULL, 'SIMPLE', 'MEDIUM', 100, 'other');
    CREATE TABLE cloud_provider_config (id TEXT PRIMARY KEY, provider TEXT, "isDefault" BOOLEAN);
    CREATE TABLE user_cloud_provider_config (LIKE cloud_provider_config INCLUDING ALL);
    INSERT INTO cloud_provider_config VALUES ('example-org-default', 'OPENAI_DIRECT', true), ('example-org-empty', 'AWS_BEDROCK', false);
    INSERT INTO user_cloud_provider_config VALUES ('example-user-non-default', 'OPENAI_DIRECT', false), ('example-user-empty', 'AWS_BEDROCK', true);
    ALTER TABLE cloud_provider_config ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cloud_provider_config FORCE ROW LEVEL SECURITY;
    ALTER TABLE user_cloud_provider_config ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_cloud_provider_config FORCE ROW LEVEL SECURITY;
   `);
				await client.query(sql);
				// Backfill policies are gone; these reads would be empty without a tenant policy.
				expect(
					(await client.query("SELECT * FROM cloud_provider_config"))
						.rows,
				).toHaveLength(0);
				for (const table of [
					"cloud_provider_config",
					"user_cloud_provider_config",
				]) {
					await client.query(
						`CREATE POLICY test_read ON "${table}" FOR SELECT USING (true)`,
					);
					const result = await client.query(
						`SELECT provider, task_defaults_snapshot FROM "${table}" ORDER BY provider`,
					);
					for (const row of result.rows) {
						expect(row.task_defaults_snapshot.version).toBe(1);
						expect(row.task_defaults_snapshot.scoped).toEqual({
							SIMPLE: null,
							COMPLEX: null,
							REASONING: null,
							CHAT:
								row.provider === "OPENAI_DIRECT"
									? "example-live-old"
									: null,
							TOOL_CALLING: null,
							EVAL: null,
						});
						expect(row.task_defaults_snapshot.unscoped).toEqual({
							SIMPLE: "example-other",
							COMPLEX: null,
							REASONING: "example-fallback",
							CHAT: "example-other",
							TOOL_CALLING: null,
							EVAL: null,
						});
						expect(
							Number.isNaN(
								Date.parse(
									row.task_defaults_snapshot.capturedAt,
								),
							),
						).toBe(false);
					}
					const columns = await client.query(
						"SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'task_defaults_snapshot'",
						[name, table],
					);
					expect(columns.rows).toEqual([
						{
							is_nullable: "YES",
							column_default: null,
							data_type: "jsonb",
						},
					]);
				}
				expect(
					(
						await client.query(
							"SELECT * FROM pg_policies WHERE schemaname = $1 AND policyname = 'pin_task_defaults_backfill'",
							[name],
						)
					).rows,
				).toEqual([]);
			} finally {
				await client.query("ROLLBACK");
				await client.query("RESET ROLE");
				await client.query("RESET search_path");
				await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
				await client.query(`DROP ROLE IF EXISTS "${role}"`);
				await client.end();
			}
		});
	},
);
