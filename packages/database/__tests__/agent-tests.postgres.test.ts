import { randomUUID } from "node:crypto";
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
import {
	normalizeAgentExecutionRequest,
	readAgentExecutionAdmission,
} from "../prisma/queries/agent-deployments/admission";

// Opt-in proof on actual migrated tables. All fixtures, grants and the
// NOSUPERUSER/NOBYPASSRLS role exist in one transaction and are rolled back.
const enabled = process.env.RUN_DB_INTEGRATION === "1";
const suffix = randomUUID();
const prefix = `example-agent-test-${suffix}`;
const fixture = (name: string) => `${prefix}-${name}`;
const role = `example_agent_test_${suffix.replaceAll("-", "").slice(0, 12)}`;
const owner = fixture("owner");
const member = fixture("member");
const org = fixture("org");
const otherOrg = fixture("other-org");
const family = fixture("family");
const instance = fixture("v1");
const v2 = fixture("v2");
const memberInstance = fixture("member-v1");
const otherInstance = fixture("other-v1");
const testCase = fixture("case");
const memberCase = fixture("member-case");
const otherCase = fixture("other-case");
const nativeRunId = randomUUID();
const message = "Summarize the example delivery progress.";
const checks = { requiredPhrases: ["Ready"], forbiddenPhrases: ["Blocked"] };
const scope = {
	instanceId: instance,
	workspaceIds: [],
	workspaceDocumentFilters: [],
	skillIds: [],
};
const report = {
	version: 1,
	method: "exact-text",
	outputHash: "a".repeat(64),
	passed: 2,
	total: 2,
	results: [
		{ kind: "required", index: 0, passed: true },
		{ kind: "forbidden", index: 0, passed: true },
	],
	durationMs: 5,
	inputTokens: 2,
	outputTokens: 1,
	totalCost: "0.01",
};
let client: Client;
async function insert(table: string, data: Record<string, unknown>) {
	const keys = Object.keys(data);
	return client.query(
		`INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
		keys.map((key) => data[key]),
	);
}
function caseData(overrides: Record<string, unknown> = {}) {
	return {
		id: fixture(`case-${randomUUID()}`),
		organizationId: org,
		userId: owner,
		agentSId: family,
		originInstanceId: instance,
		name: "Example delivery check",
		input: message,
		checksJson: JSON.stringify(checks),
		sourceScopeJson: JSON.stringify(scope),
		updatedAt: new Date(),
		...overrides,
	};
}
function runData(overrides: Record<string, unknown> = {}) {
	return {
		id: fixture(`run-${randomUUID()}`),
		organizationId: org,
		userId: owner,
		caseId: testCase,
		instanceId: instance,
		agentSId: family,
		agentVersion: 1,
		caseRevision: 1,
		caseInput: message,
		checksJson: JSON.stringify(checks),
		sourceScopeJson: JSON.stringify({ origin: scope, execution: scope }),
		requestKey: randomUUID(),
		requestHash: "a".repeat(64),
		evaluationWorkflowId: fixture(`assessment-${randomUUID()}`),
		updatedAt: new Date(),
		...overrides,
	};
}
async function denied(sql: string, params: unknown[], code: string) {
	await client.query("SAVEPOINT expected_denial");
	let error: unknown;
	try {
		await client.query(sql, params);
	} catch (caught) {
		error = caught;
	} finally {
		await client.query("ROLLBACK TO SAVEPOINT expected_denial");
		await client.query("RELEASE SAVEPOINT expected_denial");
	}
	expect(error).toMatchObject({ code });
}
async function deniedInsert(
	table: string,
	data: Record<string, unknown>,
	code = "23514",
) {
	const keys = Object.keys(data);
	await denied(
		`INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
		keys.map((key) => data[key]),
		code,
	);
}
async function asOwner(
	userId = owner,
	organizationId = org,
	type = "organization",
) {
	await client.query(`SET LOCAL ROLE "${role}"`);
	await client.query(
		"SELECT set_config('app.tenant_type',$1,true),set_config('app.tenant_id',$2,true),set_config('app.user_id',$3,true)",
		[type, organizationId, userId],
	);
	const actual = (
		await client.query(
			"SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
		)
	).rows[0];
	expect(actual).toEqual({
		rolname: role,
		rolsuper: false,
		rolbypassrls: false,
	});
}

describe.skipIf(!enabled)(
	"saved agent test PostgreSQL constraints and RLS",
	() => {
		beforeAll(async () => {
			const configured =
				process.env.AGENT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
			if (!configured) {
				throw Error("Explicit local test database required");
			}
			const url = new URL(configured);
			if (
				!["postgres:", "postgresql:"].includes(url.protocol) ||
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
				!/^\/example_[a-z0-9_]+$/.test(url.pathname) ||
				url.search
			) {
				throw Error(
					"Only explicitly selected loopback example_* databases without URL parameters are allowed",
				);
			}
			client = new Client({ connectionString: configured });
			await client.connect();
			await client.query("BEGIN");
			for (const id of [org, otherOrg]) {
				await insert("organization", {
					id,
					name: "Example agent tests",
					slug: id,
					createdAt: new Date(),
				});
			}
			for (const id of [owner, member]) {
				await insert("user", {
					id,
					name: "Example test member",
					email: `${id}@example.com`,
					emailVerified: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				});
			}
			await insert("agent_template", {
				id: fixture("template"),
				slug: fixture("template"),
				name: "Example",
				displayName: "Example",
				description: "Synthetic regression fixture",
				category: "ENGINEERING",
				instructions: "Return a delivery brief.",
				updatedAt: new Date(),
			});
			for (const [id, userId, organizationId, sId, version] of [
				[instance, owner, org, family, 1],
				[v2, owner, org, family, 2],
				[memberInstance, member, org, fixture("member-family"), 1],
				[otherInstance, owner, otherOrg, fixture("other-family"), 1],
			] as const) {
				await insert("agent_template_instance", {
					id,
					userId,
					organizationId,
					sId,
					version,
					templateId: fixture("template"),
					name: "Example agent",
					updatedAt: new Date(),
				});
				await insert("agent_deployment", {
					id: `${id}-deployment`,
					instanceId: id,
					userId,
					organizationId,
					name: "Example deployment",
					slug: id,
					updatedAt: new Date(),
				});
				await insert("agent_deployment_execution", {
					id: `${id}-execution`,
					deploymentId: `${id}-deployment`,
					userId,
					organizationId,
					executionId: `${id}-execution-key`,
					triggerType: "manual",
					input: JSON.stringify({ message }),
					metadata: JSON.stringify({
						fabricAdmission: {
							version: 1,
							receiptOwner: "workflow",
							executionCountReserved: true,
							requestHash: normalizeAgentExecutionRequest({
								input: { message },
								priority: 5,
							}).hash,
							dispatch: {
								instanceId: id,
								workflowType:
									"nativeDeploymentExecutionWorkflow",
							},
							imageRefs: [],
						},
					}),
					workflowId: `${id}-workflow`,
					runId: nativeRunId,
					updatedAt: new Date(),
				});
			}
			await insert("agent_deployment_execution", {
				id: fixture("wrong-input"),
				deploymentId: `${instance}-deployment`,
				userId: owner,
				organizationId: org,
				executionId: fixture("wrong-input-key"),
				triggerType: "manual",
				input: JSON.stringify({ message: "Different task" }),
				metadata: JSON.stringify({
					fabricAdmission: {
						version: 1,
						requestHash: normalizeAgentExecutionRequest({
							input: { message: "Different task" },
							priority: 5,
						}).hash,
						dispatch: {
							instanceId: instance,
							workflowType: "nativeDeploymentExecutionWorkflow",
						},
						imageRefs: [],
					},
				}),
				workflowId: `${instance}-workflow`,
				runId: nativeRunId,
				updatedAt: new Date(),
			});
			await insert("agent_test_case", caseData({ id: testCase }));
			await insert(
				"agent_test_case",
				caseData({
					id: memberCase,
					userId: member,
					originInstanceId: memberInstance,
					agentSId: fixture("member-family"),
				}),
			);
			await insert(
				"agent_test_case",
				caseData({
					id: otherCase,
					organizationId: otherOrg,
					originInstanceId: otherInstance,
					agentSId: fixture("other-family"),
				}),
			);
			await insert(
				"agent_test_run",
				runData({ id: fixture("base-run") }),
			);
			await client.query(
				`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`,
			);
			await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
			await client.query(
				`GRANT SELECT ON agent_template_instance,agent_deployment,agent_deployment_execution TO "${role}"`,
			);
			await client.query(
				`GRANT SELECT,INSERT,UPDATE,DELETE ON agent_test_case,agent_test_run TO "${role}"`,
			);
		});
		beforeEach(async () => {
			await client.query("SAVEPOINT test_case");
		});
		afterEach(async () => {
			await client.query("ROLLBACK TO SAVEPOINT test_case");
			await client.query("RELEASE SAVEPOINT test_case");
		});
		afterAll(async () => {
			if (!client) {
				return;
			}
			try {
				await client.query("ROLLBACK");
				expect(
					(
						await client.query(
							"SELECT count(*)::int AS count FROM agent_test_case WHERE id LIKE $1",
							[`${prefix}%`],
						)
					).rows[0].count,
				).toBe(0);
				expect(
					(
						await client.query(
							"SELECT count(*)::int AS count FROM pg_roles WHERE rolname=$1",
							[role],
						)
					).rows[0].count,
				).toBe(0);
			} finally {
				await client.end();
			}
		});
		it("valid native execution links match the actual top-level input.message and exact Temporal execution", async () => {
			const data = runData({
				executionId: `${instance}-execution`,
				nativeWorkflowId: `${instance}-workflow`,
				nativeRunId: nativeRunId,
				status: "RUNNING",
			});
			await insert("agent_test_run", data);
			const row = (
				await client.query(
					'SELECT r."caseInput",e.input->>\'message\' AS message FROM agent_test_run r JOIN agent_deployment_execution e ON e.id=r."executionId" WHERE r.id=$1',
					[data.id],
				)
			).rows[0];
			expect(row).toEqual({ caseInput: message, message });
		});
		it("historical native receipts remain valid after a deployment is retargeted to the next version", async () => {
			const data = runData({
				executionId: `${instance}-execution`,
				nativeWorkflowId: `${instance}-workflow`,
				nativeRunId,
				status: "RUNNING",
			});
			await insert("agent_test_run", data);
			const execution = (
				await client.query(
					"SELECT metadata FROM agent_deployment_execution WHERE id=$1",
					[`${instance}-execution`],
				)
			).rows[0];
			expect(
				readAgentExecutionAdmission(execution)?.dispatch.instanceId,
			).toBe(instance);
			// Version creation reuses the active deployment for the next immutable instance.
			await client.query("DELETE FROM agent_deployment WHERE id=$1", [
				`${v2}-deployment`,
			]);
			await client.query(
				'UPDATE agent_deployment SET "instanceId"=$1 WHERE id=$2',
				[v2, `${instance}-deployment`],
			);
			const updated = await client.query(
				'UPDATE agent_test_run SET status=$3,verdict=$4,"reportJson"=$1,"completedAt"=now() WHERE id=$2 RETURNING status',
				[JSON.stringify(report), data.id, "COMPLETED", "PASSED"],
			);
			expect(updated.rows).toEqual([{ status: "COMPLETED" }]);
		});
		it("a current deployment pointer cannot forge the original immutable admission instance", async () => {
			const data = runData({
				executionId: `${instance}-execution`,
				nativeWorkflowId: `${instance}-workflow`,
				nativeRunId,
			});
			await client.query(
				"UPDATE agent_deployment_execution SET metadata=jsonb_set(metadata,$3::text[],to_jsonb($1::text)) WHERE id=$2",
				[
					v2,
					`${instance}-execution`,
					["fabricAdmission", "dispatch", "instanceId"],
				],
			);
			await deniedInsert("agent_test_run", data);
		});
		it("rejects missing, malformed and legacy non-native admission markers", async () => {
			const valid = {
				version: 1,
				requestHash: normalizeAgentExecutionRequest({
					input: { message },
					priority: 5,
				}).hash,
				dispatch: {
					instanceId: instance,
					workflowType: "nativeDeploymentExecutionWorkflow",
				},
				imageRefs: [],
			};
			for (const marker of [
				null,
				{ ...valid, version: 2 },
				{ ...valid, requestHash: "invalid" },
				{ ...valid, imageRefs: {} },
				{
					...valid,
					dispatch: {
						...valid.dispatch,
						workflowType: "deploymentExecutionWorkflow",
					},
				},
			]) {
				await client.query("SAVEPOINT admission_marker");
				try {
					await client.query(
						"UPDATE agent_deployment_execution SET metadata=$1 WHERE id=$2",
						[
							JSON.stringify({ fabricAdmission: marker }),
							`${instance}-execution`,
						],
					);
					await deniedInsert(
						"agent_test_run",
						runData({
							executionId: `${instance}-execution`,
							nativeWorkflowId: `${instance}-workflow`,
							nativeRunId,
						}),
					);
				} finally {
					await client.query(
						"ROLLBACK TO SAVEPOINT admission_marker",
					);
					await client.query("RELEASE SAVEPOINT admission_marker");
				}
			}
		});
		it("rejects case owners, organizations and families that disagree with the origin instance", async () => {
			for (const overrides of [
				{ userId: member },
				{ organizationId: otherOrg },
				{ agentSId: fixture("other-family") },
			]) {
				await deniedInsert("agent_test_case", caseData(overrides));
			}
		});
		it("rejects run case/owner/org/family and target-version mismatches", async () => {
			for (const overrides of [
				{ caseId: memberCase },
				{ caseId: otherCase },
				{ userId: member },
				{ organizationId: otherOrg },
				{ agentSId: fixture("other-family") },
				{ agentVersion: 2 },
				{ instanceId: v2 },
				{ instanceId: memberInstance },
				{ instanceId: otherInstance },
			]) {
				await deniedInsert("agent_test_run", runData(overrides));
			}
		});
		it("accepts a newer version of the same owner/family and retains frozen old expectations", async () => {
			const targetScope = { ...scope, instanceId: v2 };
			const data = runData({
				instanceId: v2,
				agentVersion: 2,
				sourceScopeJson: JSON.stringify({
					origin: scope,
					execution: targetScope,
				}),
			});
			await insert("agent_test_run", data);
			await client.query(
				'UPDATE agent_test_case SET input=$1,"checksJson"=$2,revision=2 WHERE id=$3',
				[
					"New task",
					JSON.stringify({ requiredPhrases: ["New"] }),
					testCase,
				],
			);
			const row = (
				await client.query(
					'SELECT "caseRevision","caseInput","checksJson","sourceScopeJson" FROM agent_test_run WHERE id=$1',
					[data.id],
				)
			).rows[0];
			expect(row).toEqual({
				caseRevision: 1,
				caseInput: message,
				checksJson: checks,
				sourceScopeJson: { origin: scope, execution: targetScope },
			});
		});
		it("rejects unrelated native deployments, owners, input messages and workflow/run identities", async () => {
			const native = {
				executionId: `${instance}-execution`,
				nativeWorkflowId: `${instance}-workflow`,
				nativeRunId: nativeRunId,
			};
			for (const overrides of [
				{ executionId: `${v2}-execution` },
				{ executionId: `${memberInstance}-execution` },
				{ executionId: `${otherInstance}-execution` },
				{ executionId: fixture("wrong-input") },
				{ nativeWorkflowId: "other-workflow" },
				{ nativeWorkflowId: null },
				{ nativeRunId: "other-run" },
				{ caseInput: "Different task" },
			]) {
				await deniedInsert(
					"agent_test_run",
					runData({ ...native, ...overrides }),
				);
			}
		});
		it("bounds payload bytes and valid state/revision/hash values", async () => {
			for (const overrides of [
				{ input: "x".repeat(80001) },
				{ checksJson: JSON.stringify({ x: "x".repeat(70001) }) },
				{ sourceScopeJson: JSON.stringify({ x: "x".repeat(131073) }) },
				{ revision: 0 },
			]) {
				await deniedInsert("agent_test_case", caseData(overrides));
			}
			for (const overrides of [
				{ caseInput: "x".repeat(80001) },
				{ sourceScopeJson: JSON.stringify({ x: "x".repeat(262145) }) },
				{ caseRevision: 0 },
				{ agentVersion: 0 },
				{ requestHash: "invalid" },
				{ status: "UNKNOWN" },
				{ verdict: "UNKNOWN" },
			]) {
				await deniedInsert("agent_test_run", runData(overrides));
			}
		});
		it("accepts bounded metrics/check reports while rejecting raw-output keys and invalid envelopes", async () => {
			await insert(
				"agent_test_run",
				runData({
					reportJson: JSON.stringify(report),
					status: "COMPLETED",
					verdict: "PASSED",
				}),
			);
			for (const invalid of [
				[],
				{ ...report, rawOutput: "Do not persist native answers" },
				{ ...report, version: 2 },
				{ ...report, method: "unknown" },
				{ ...report, results: "x".repeat(9000) },
			]) {
				await deniedInsert(
					"agent_test_run",
					runData({ reportJson: JSON.stringify(invalid) }),
				);
			}
		});
		it("makes retry identity unique per owner and prevents attaching one native execution to two tests", async () => {
			const requestKey = randomUUID();
			await insert("agent_test_run", runData({ requestKey }));
			await deniedInsert(
				"agent_test_run",
				runData({ requestKey }),
				"23505",
			);
			const native = {
				executionId: `${instance}-execution`,
				nativeWorkflowId: `${instance}-workflow`,
				nativeRunId: nativeRunId,
			};
			await insert("agent_test_run", runData(native));
			await deniedInsert("agent_test_run", runData(native), "23505");
		});
		it("enforces owner-within-org reads and denies null/wrong org context on a real restricted role", async () => {
			await asOwner();
			expect(
				(
					await client.query(
						"SELECT id FROM agent_test_case WHERE id=ANY($1)",
						[[testCase, memberCase, otherCase]],
					)
				).rows,
			).toEqual([{ id: testCase }]);
			expect(
				(
					await client.query(
						"SELECT id FROM agent_test_run WHERE id=$1",
						[fixture("base-run")],
					)
				).rowCount,
			).toBe(1);
			await asOwner(member);
			expect(
				(
					await client.query(
						"SELECT id FROM agent_test_case WHERE id=ANY($1)",
						[[testCase, memberCase]],
					)
				).rows,
			).toEqual([{ id: memberCase }]);
			await asOwner(owner, otherOrg);
			expect(
				(
					await client.query(
						"SELECT id FROM agent_test_case WHERE id=$1",
						[testCase],
					)
				).rowCount,
			).toBe(0);
			await asOwner(owner, "", "none");
			expect(
				(
					await client.query(
						"SELECT id FROM agent_test_case WHERE id=ANY($1)",
						[[testCase, memberCase, otherCase]],
					)
				).rowCount,
			).toBe(0);
		});
		it("prevents cross-owner reads, edits and deletes and disallows ownership reassignment", async () => {
			await asOwner(member);
			expect(
				(
					await client.query(
						"SELECT id FROM agent_test_run WHERE id=$1",
						[fixture("base-run")],
					)
				).rowCount,
			).toBe(0);
			expect(
				(
					await client.query(
						"UPDATE agent_test_case SET name=$1 WHERE id=$2",
						["Other", testCase],
					)
				).rowCount,
			).toBe(0);
			expect(
				(
					await client.query(
						"DELETE FROM agent_test_run WHERE id=$1",
						[fixture("base-run")],
					)
				).rowCount,
			).toBe(0);
			await asOwner();
			await denied(
				'UPDATE agent_test_case SET "userId"=$1 WHERE id=$2',
				[member, testCase],
				"23514",
			);
		});
		it("enforces WITH CHECK even when referenced resources are internally consistent", async () => {
			await asOwner();
			await deniedInsert(
				"agent_test_case",
				caseData({
					userId: member,
					originInstanceId: memberInstance,
					agentSId: fixture("member-family"),
				}),
				"42501",
			);
			await deniedInsert(
				"agent_test_case",
				caseData({
					organizationId: otherOrg,
					originInstanceId: otherInstance,
					agentSId: fixture("other-family"),
				}),
				"42501",
			);
		});
		it("forces RLS on both tables and keeps intended composite/history/retry indexes", async () => {
			const policies = (
				await client.query(
					"SELECT tablename,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1)",
					[["agent_test_case", "agent_test_run"]],
				)
			).rows;
			expect(policies).toHaveLength(2);
			for (const p of policies) {
				expect(p.qual).toContain("current_user_id()");
				expect(p.with_check).toContain("current_user_id()");
			}
			const rows = (
				await client.query(
					"SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)",
					[["agent_test_case", "agent_test_run"]],
				)
			).rows;
			expect(
				rows.every(
					(row) => row.relrowsecurity && row.relforcerowsecurity,
				),
			).toBe(true);
			const indexes = (
				await client.query(
					"SELECT indexdef FROM pg_indexes WHERE tablename='agent_test_run'",
				)
			).rows
				.map((row) => row.indexdef)
				.join("\n");
			expect(indexes).toContain(
				'("organizationId", "userId", "requestKey")',
			);
			expect(indexes).toContain('("caseId", "createdAt" DESC)');
		});
	},
);
