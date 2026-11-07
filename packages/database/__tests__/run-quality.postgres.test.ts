import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

const enabled = process.env.RUN_DB_INTEGRATION === "1";
const suffix = randomUUID();
const id = (name: string) => `example-quality-${suffix}-${name}`;
const actor = { organizationId: id("org"), userId: id("owner") };
const role = `example_quality_${suffix.replaceAll("-", "").slice(0, 12)}`;
const rules = JSON.stringify([
	{
		id: "ready",
		name: "Ready",
		required: true,
		nodeId: "answer",
		checks: { requiredPhrases: ["Ready"], forbiddenPhrases: [] },
	},
]);
let client: Client;
async function insert(table: string, data: Record<string, unknown>) {
	const keys = Object.keys(data);
	return client.query(
		`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
		Object.values(data),
	);
}
const policy = (extra: Record<string, unknown> = {}) => ({
	id: id(randomUUID()),
	...actor,
	workflowId: id("workflow"),
	enabled: true,
	rulesJson: rules,
	updatedAt: new Date(),
	...extra,
});
const assessment = (extra: Record<string, unknown> = {}) => ({
	id: id(randomUUID()),
	...actor,
	policyId: id("policy"),
	policyRevision: 1,
	sourceVersion: 1,
	workflowExecutionId: id("execution"),
	nativeWorkflowId: id("native"),
	nativeRunId: randomUUID(),
	assessmentWorkflowId: id(randomUUID()),
	sourceScopeJson: JSON.stringify({
		kind: "WORKFLOW",
		projectId: null,
		workspaceIds: [],
		skillIds: [],
	}),
	rulesJson: rules,
	rulesHash: "a".repeat(64),
	deadlineAt: new Date(Date.now() + 60_000),
	updatedAt: new Date(),
	...extra,
});
async function denied(
	table: string,
	data: Record<string, unknown>,
	code = "23514",
) {
	await client.query("SAVEPOINT expected_denial");
	let error: unknown;
	try {
		await insert(table, data);
	} catch (caught) {
		error = caught;
	} finally {
		await client.query("ROLLBACK TO SAVEPOINT expected_denial");
		await client.query("RELEASE SAVEPOINT expected_denial");
	}
	expect(error).toMatchObject({ code });
}
describe.skipIf(!enabled)(
	"recorded quality actual PostgreSQL constraints and RLS",
	() => {
		beforeAll(async () => {
			const configured =
				process.env.DIRECT_URL ?? process.env.DATABASE_URL;
			if (!configured) throw Error("Explicit test DB required");
			const url = new URL(configured);
			if (
				!["postgres:", "postgresql:"].includes(url.protocol) ||
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
				!/^\/example_[a-z0-9_]+$/.test(url.pathname) ||
				url.search
			)
				throw Error(
					"Only loopback example_* test databases without URL params are allowed",
				);
			client = new Client({ connectionString: configured });
			await client.connect();
			await client.query("BEGIN");
			// Before applying a new migration, validate its actual SQL transactionally. The
			// outer rollback removes the new tables/roles/fixtures; history is untouched.
			if (
				!(
					await client.query(
						"SELECT to_regclass('public.run_quality_policy') AS table_name",
					)
				).rows[0].table_name
			) {
				await client.query(
					readFileSync(
						new URL(
							"../prisma/migrations/20261106083503_recorded_run_quality/migration.sql",
							import.meta.url,
						),
						"utf8",
					),
				);
			}
			if (
				!(
					await client.query(
						"SELECT to_regclass('public.run_quality_assessment_native_workflow_key') AS index_name",
					)
				).rows[0].index_name
			) {
				await client.query(
					readFileSync(
						new URL(
							"../prisma/migrations/20261106100830_quality_report_compatibility/migration.sql",
							import.meta.url,
						),
						"utf8",
					),
				);
			}
			for (const name of ["org", "other-org"])
				await insert("organization", {
					id: id(name),
					name: "Example quality tests",
					slug: id(name),
					createdAt: new Date(),
				});
			for (const name of ["owner", "member"])
				await insert("user", {
					id: id(name),
					name: "Example member",
					email: `${id(name)}@example.com`,
					emailVerified: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				});
			for (const [name, userId, organizationId] of [
				["workflow", actor.userId, actor.organizationId],
				["member-workflow", id("member"), actor.organizationId],
				["other-workflow", actor.userId, id("other-org")],
			])
				await insert("workflow", {
					id: id(name),
					name: "Example workflow",
					userId,
					organizationId,
					nodes: "[]",
					edges: "[]",
					updatedAt: new Date(),
				});
			for (const [name, workflowId, userId, organizationId] of [
				[
					"execution",
					id("workflow"),
					actor.userId,
					actor.organizationId,
				],
				[
					"member-execution",
					id("member-workflow"),
					id("member"),
					actor.organizationId,
				],
				[
					"other-execution",
					id("other-workflow"),
					actor.userId,
					id("other-org"),
				],
			])
				await insert("workflow_execution", {
					id: id(name),
					workflowId,
					userId,
					organizationId,
					version: 1,
					triggerType: "MANUAL",
					temporalRunId: id("native"),
				});
			await insert("run_quality_policy", policy({ id: id("policy") }));
			await insert(
				"run_quality_assessment",
				assessment({ id: id("assessment") }),
			);
			await client.query(
				`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOLOGIN`,
			);
			await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
			await client.query(
				`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`,
			);
			await client.query(
				`GRANT INSERT,UPDATE ON run_quality_policy,run_quality_assessment TO "${role}"`,
			);
		});
		afterAll(async () => {
			if (client) {
				await client.query("ROLLBACK");
				await client.end();
			}
		});
		beforeEach(async () => {
			await client.query("SAVEPOINT example_test");
		});
		afterEach(async () => {
			await client.query("ROLLBACK TO SAVEPOINT example_test");
			await client.query("RELEASE SAVEPOINT example_test");
		});
		it("accepts a valid minimized completed report", async () => {
			const report = {
				version: 1,
				scorerVersion: "fabric-deterministic-v1",
				rules: [
					{
						id: "ready",
						name: "Ready",
						required: true,
						status: "PASSED",
						outputHash: "b".repeat(64),
						grade: {
							version: 2,
							method: "deterministic",
							scorerVersion: "fabric-deterministic-v1",
							status: "PASSED",
							passed: 1,
							total: 1,
							unavailable: 0,
							results: [
								{
									kind: "required",
									index: 0,
									passed: true,
									available: true,
								},
							],
						},
					},
				],
				coverage: { total: 1, passed: 1, failed: 0, unavailable: 0 },
			};
			const result = await client.query(
				'UPDATE run_quality_assessment SET status=$1,verdict=$2,"reportJson"=$3,"completedAt"=NOW() WHERE id=$4 RETURNING verdict',
				[
					"COMPLETED",
					"PASSED",
					JSON.stringify(report),
					id("assessment"),
				],
			);
			expect(result.rows[0].verdict).toBe("PASSED");
		});
		it("rejects cross-tenant and cross-actor target policies", async () => {
			await denied(
				"run_quality_policy",
				policy({ workflowId: id("other-workflow") }),
			);
			await denied(
				"run_quality_policy",
				policy({ workflowId: id("member-workflow") }),
			);
		});
		it("rejects cross-tenant/actor/wrong native execution references", async () => {
			await denied(
				"run_quality_assessment",
				assessment({ workflowExecutionId: id("other-execution") }),
			);
			await denied(
				"run_quality_assessment",
				assessment({ workflowExecutionId: id("member-execution") }),
			);
			await denied(
				"run_quality_assessment",
				assessment({ nativeWorkflowId: id("wrong-native") }),
			);
		});
		it("rejects both missing target and invalid rule JSON with a constraint error", async () => {
			await denied("run_quality_policy", policy({ workflowId: null }));
			await denied("run_quality_policy", policy({ rulesJson: "{}" }));
			await denied("run_quality_policy", policy({ rulesJson: "[]" }));
		});
		it("rejects arbitrary output copied into source evidence", async () => {
			await denied(
				"run_quality_assessment",
				assessment({
					sourceScopeJson: JSON.stringify({
						kind: "WORKFLOW",
						output: "Example private output",
					}),
				}),
			);
		});
		it("rejects an output-shaped report", async () => {
			await denied(
				"run_quality_assessment",
				assessment({
					workflowExecutionId: id("execution"),
					status: "COMPLETED",
					verdict: "PASSED",
					completedAt: new Date(),
					reportJson: JSON.stringify({
						version: 1,
						output: "Example private output",
					}),
				}),
			);
		});
		it("does not permit PASSED without evidence", async () => {
			await denied(
				"run_quality_assessment",
				assessment({
					status: "COMPLETED",
					verdict: "PASSED",
					completedAt: new Date(),
				}),
			);
		});
		it("allows distinct native runs of one execution but never duplicates the same native run", async () => {
			const original = (
				await client.query(
					'SELECT "nativeRunId" FROM run_quality_assessment WHERE id=$1',
					[id("assessment")],
				)
			).rows[0];
			await denied(
				"run_quality_assessment",
				assessment({ nativeRunId: original.nativeRunId }),
				"23505",
			);
			const second = assessment();
			await insert("run_quality_assessment", second);
			await denied(
				"run_quality_assessment",
				assessment({ nativeRunId: second.nativeRunId }),
				"23505",
			);
		});
		it.each([
			[actor.userId, actor.organizationId, "organization", 1],
			[id("member"), actor.organizationId, "organization", 0],
			[actor.userId, id("other-org"), "organization", 0],
			[actor.userId, actor.organizationId, "personal", 0],
		])(
			"isolates actual restricted-role reads %s/%s/%s",
			async (user, org, type, count) => {
				await client.query(`SET LOCAL ROLE "${role}"`);
				await client.query(
					"SELECT set_config('app.tenant_type',$1,true),set_config('app.tenant_id',$2,true),set_config('app.user_id',$3,true)",
					[type, org, user],
				);
				expect(
					(
						await client.query(
							"SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user",
						)
					).rows[0],
				).toEqual({ rolbypassrls: false, rolsuper: false });
				for (const table of [
					"run_quality_policy",
					"run_quality_assessment",
				])
					expect(
						(
							await client.query(
								`SELECT id FROM ${table} WHERE "organizationId"=$1`,
								[actor.organizationId],
							)
						).rowCount,
					).toBe(count);
			},
		);
	},
);
