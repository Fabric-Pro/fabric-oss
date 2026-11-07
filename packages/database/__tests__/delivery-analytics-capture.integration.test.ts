import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { db } from "../prisma/client";
import { disposableTarget } from "../scripts/prisma-disposable.mjs";

const ORG = "c000000000000000000000001";
const PROJECT = "c000000000000000000000002";
const USER = "c000000000000000000000003";
const STATUS = "c000000000000000000000004";
const STORY = "c000000000000000000000006";
const RUN = "c000000000000000000000007";

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"Delivery analytics capture",
	() => {
		let client: Client;
		const provisionedRoles: string[] = [];
		beforeAll(async () => {
			let target: string;
			try {
				target = disposableTarget("reset", {
					DIRECT_URL: process.env.DATABASE_URL,
				});
			} catch {
				throw new Error(
					"Delivery analytics capture setup refused: DATABASE_URL must target a disposable loopback PostgreSQL database named example_* with no URL parameters.",
				);
			}
			client = new Client({ connectionString: target });
			await client.connect();
			for (const role of ["fabric_app", "fabric_worker"]) {
				if (
					(
						await client.query(
							"SELECT 1 FROM pg_roles WHERE rolname=$1",
							[role],
						)
					).rowCount === 0
				) {
					await client.query(
						`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`,
					);
					provisionedRoles.push(role);
				}
			}
			execFileSync(
				"pnpm",
				["exec", "tsx", "scripts/apply-rls-direct.ts"],
				{
					cwd: resolve(__dirname, ".."),
					env: {
						...process.env,
						APP_RLS_BYPASS: "true",
						WORKER_RLS_MODE: "policy",
						WORKER_ROLE_PREPROVISIONED: "true",
					},
					stdio: "pipe",
				},
			);
		}, 30000);
		afterAll(async () => {
			for (const role of provisionedRoles) {
				await client.query(`DROP OWNED BY ${role}`);
				await client.query(`DROP ROLE ${role}`);
			}
			await client?.end();
			await db.$disconnect();
		});
		beforeEach(async ({ task }) => {
			await client.query("BEGIN");
			await client.query(
				`INSERT INTO organization (id, name, "createdAt") VALUES ($1, 'Example', now())`,
				[ORG],
			);
			await client.query(
				`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Example', 'dev@example.com', false, now(), now())`,
				[USER],
			);
			await client.query(
				`INSERT INTO project (id, name, "userId", "organizationId", "updatedAt") VALUES ($1, 'Example', $2, $3, now())`,
				[PROJECT, USER, ORG],
			);
			await client.query(
				`INSERT INTO project_story_status (id, "projectId", name, color, "order", "updatedAt") VALUES ($1, $2, 'Example', '#000000', 0, now())`,
				[STATUS, PROJECT],
			);
			if (!task.name.includes("disabled")) {
				await client.query(
					`INSERT INTO organization_feature_flag_override (key, "organizationId", enabled, "updatedBy", "updatedAt") VALUES ('DELIVERY_ANALYTICS', $1, true, $2, now())`,
					[ORG, USER],
				);
			}
		});
		afterEach(async () => {
			await client.query("ROLLBACK");
		});

		const insertStory = async () =>
			client.query(
				`INSERT INTO user_story (id, "projectId", "statusId", identifier, title, "createdById", "updatedAt") VALUES ($1, $2, $3, $1, 'Example', $4, now())`,
				[STORY, PROJECT, STATUS, USER],
			);
		const insertRun = async () =>
			client.query(
				`INSERT INTO coding_run (id, "projectId", "storyId", "userId", "organizationId", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`,
				[RUN, PROJECT, STORY, USER, ORG],
			);
		const events = async () =>
			(
				await client.query(
					"SELECT * FROM lakehouse_export.delivery_event ORDER BY occurred_at, id",
				)
			).rows;

		it("captures stage and run transitions without source content", async () => {
			await insertStory();
			await client.query(
				`UPDATE user_story SET "draftingStage"='SANITY_CHECK' WHERE id=$1`,
				[STORY],
			);
			await client.query(
				`UPDATE user_story SET "draftingStage"='PUBLISHED' WHERE id=$1`,
				[STORY],
			);
			await insertRun();
			await client.query(
				"UPDATE coding_run SET status='RUNNING' WHERE id=$1",
				[RUN],
			);
			await client.query(
				"UPDATE coding_run SET status='COMPLETED' WHERE id=$1",
				[RUN],
			);

			const rows = await events();
			expect(rows.map((row) => row.event_type)).toEqual([
				"created",
				"stage_changed",
				"stage_changed",
				"created",
				"status_changed",
				"status_changed",
			]);
			expect(rows[1]).toMatchObject({
				organization_id: ORG,
				project_id: PROJECT,
				subject_type: "story",
				subject_id: STORY,
				from_state: "PLACEHOLDER",
				to_state: "SANITY_CHECK",
			});
			expect(rows[2]).toMatchObject({
				from_state: "SANITY_CHECK",
				to_state: "PUBLISHED",
			});
			expect(rows.at(-1)).toMatchObject({
				subject_type: "coding_run",
				subject_id: RUN,
				from_state: "RUNNING",
				to_state: "COMPLETED",
			});
			for (const row of rows) {
				expect(row).not.toHaveProperty("payload");
				expect(row).not.toHaveProperty("actor_id");
			}
		});

		it("does not capture while delivery analytics is disabled", async () => {
			await insertStory();
			expect(await events()).toHaveLength(0);
		});

		it("enforces append-only history and purges with the parent project", async () => {
			await insertStory();
			await client.query("SAVEPOINT reject_mutation");
			await expect(
				client.query(
					"UPDATE lakehouse_export.delivery_event SET to_state='CHANGED'",
				),
			).rejects.toThrow("append-only");
			await client.query("ROLLBACK TO SAVEPOINT reject_mutation");
			await client.query("DELETE FROM project WHERE id=$1", [PROJECT]);
			expect(await events()).toHaveLength(0);
		});

		it("passes preflight only after all required sources are visible", async () => {
			await insertStory();
			await insertRun();
			const result = await client.query(
				"SELECT * FROM lakehouse_export.delivery_capture_preflight() ORDER BY table_name",
			);
			expect(result.rows).toHaveLength(3);
			expect(result.rows.every((row) => row.passed)).toBe(true);
		});

		it("filters exported rows by the active organization", async () => {
			await insertStory();
			await client.query(
				"CREATE ROLE delivery_reader NOSUPERUSER NOBYPASSRLS",
			);
			await client.query(
				"GRANT USAGE ON SCHEMA lakehouse_export TO delivery_reader",
			);
			await client.query(
				"GRANT SELECT ON lakehouse_export.delivery_event TO delivery_reader",
			);
			await client.query("SET ROLE delivery_reader");
			await client.query(
				"SELECT set_config('app.tenant_type', 'organization', true), set_config('app.tenant_id', $1, true)",
				[ORG],
			);
			expect(await events()).toHaveLength(1);
			await client.query(
				"SELECT set_config('app.tenant_id', 'c000000000000000000000099', true)",
			);
			expect(await events()).toHaveLength(0);
			await client.query("RESET ROLE");
			await client.query("DROP OWNED BY delivery_reader");
			await client.query("DROP ROLE delivery_reader");
		});
	},
);
