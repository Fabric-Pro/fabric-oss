import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigration } from "../scripts/lint-migrations";

const sql = readFileSync(
	new URL(
		"../prisma/migrations/20261104071437_agent_regression_tests/migration.sql",
		import.meta.url,
	),
	"utf8",
).replace(/\s+/g, " ");
const nativeReceiptSql = readFileSync(
	new URL(
		"../prisma/migrations/20261104074249_agent_test_immutable_native_receipt/migration.sql",
		import.meta.url,
	),
	"utf8",
).replace(/\s+/g, " ");
describe("saved agent test migration contract", () => {
	it("forward receipt correction passes expand/contract migration lint without waivers", () => {
		expect(
			lintMigration({
				migration: "20261104074249_agent_test_immutable_native_receipt",
				sql: nativeReceiptSql,
				preExistingTables: new Set([
					"agent_test_case",
					"agent_test_run",
					"agent_deployment_execution",
					"agent_template_instance",
				]),
			}),
		).toEqual([]);
	});
	it.each(["agent_test_case", "agent_test_run"])(
		"%s enables forced owner-within-org policies for reads and writes",
		(table) => {
			expect(sql).toContain(
				`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
			);
			expect(sql).toContain(
				`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
			);
			const policy = sql.match(
				new RegExp(
					`CREATE POLICY tenant_isolation ON ${table} (.*?)\\);`,
				),
			)?.[1];
			expect(policy).toBeDefined();
			for (const part of ["USING", "WITH CHECK"]) {
				expect(policy?.split(part)[1]).toContain(
					`current_tenant_type()='organization'`,
				);
				expect(policy?.split(part)[1]).toContain(
					`"organizationId"=current_tenant_id()`,
				);
				expect(policy?.split(part)[1]).toContain(
					`"userId"=current_user_id()`,
				);
			}
		},
	);
	it("keeps source/case revisions and source snapshots on each run", () => {
		expect(sql).toContain('"caseRevision" INTEGER NOT NULL');
		expect(sql).toContain('"caseInput" TEXT NOT NULL');
		expect(sql.match(/"checksJson" JSONB NOT NULL/g)).toHaveLength(2);
		expect(sql.match(/"sourceScopeJson" JSONB NOT NULL/g)).toHaveLength(2);
		expect(sql).toContain(
			'FOREIGN KEY ("caseId", "organizationId", "userId") REFERENCES "agent_test_case"("id", "organizationId", "userId")',
		);
	});
	it("supports bounded family/history pagination and per-owner retry uniqueness", () => {
		expect(sql).toContain(
			'("organizationId", "userId", "agentSId", "createdAt" DESC)',
		);
		expect(sql).toContain('("caseId", "createdAt" DESC)');
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "agent_test_run_actor_request_key" ON "agent_test_run"("organizationId", "userId", "requestKey")',
		);
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "agent_test_run_executionId_key"',
		);
	});
	it("checks case and target version owner/organization/family on inserts and updates", () => {
		for (const text of [
			'i."organizationId"=NEW."organizationId"',
			'i."userId"=NEW."userId"',
			'i."sId"=NEW."agentSId"',
			'i.version=NEW."agentVersion"',
			'c."agentSId"=NEW."agentSId"',
			"BEFORE INSERT OR UPDATE ON agent_test_case",
			"BEFORE INSERT OR UPDATE ON agent_test_run",
		]) {
			expect(sql).toContain(text);
		}
	});
	it("binds to the native executor's actual message, deployment and Temporal identity", () => {
		for (const text of [
			"e.metadata#>>'{fabricAdmission,dispatch,instanceId}'=NEW.\"instanceId\"",
			`e.input->>'message'=NEW."caseInput"`,
			'e."workflowId"=NEW."nativeWorkflowId"',
			'e."runId"=NEW."nativeRunId"',
			'e."organizationId"=NEW."organizationId"',
			'e."userId"=NEW."userId"',
		]) {
			expect(nativeReceiptSql).toContain(text);
		}
		expect(nativeReceiptSql).not.toMatch(
			/JOIN\s+(?:public\.)?agent_deployment\s/,
		);
		expect(nativeReceiptSql).toContain(
			"CREATE OR REPLACE FUNCTION public.enforce_agent_test_run_scope()",
		);
		expect(nativeReceiptSql).toContain("{fabricAdmission,requestHash}");
		expect(nativeReceiptSql).toContain("nativeGoalOrientedAgentWorkflow");
		const admission = readFileSync(
			new URL(
				"../prisma/queries/agent-deployments/admission.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(admission).toContain("input: input.request.value.input");
	});
	it("bounds snapshots and retains only report metrics/checks/hash keys", () => {
		for (const text of [
			"octet_length(input) <= 80000",
			'octet_length("caseInput") <= 80000',
			'octet_length("sourceScopeJson"::text) <= 262144',
			'octet_length("reportJson"::text)<=8192',
			`status IN ('ADMITTING','RUNNING','COMPLETED','CANCELLED','ERROR')`,
			`"reportJson"->>'method'='exact-text'`,
			`"reportJson" - ARRAY['version','method','outputHash','passed','total','results','durationMs','inputTokens','outputTokens','totalCost']`,
		]) {
			expect(sql).toContain(text);
		}
	});
});
