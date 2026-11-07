import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigration } from "../scripts/lint-migrations";

const sql = readFileSync(
	new URL(
		"../prisma/migrations/20261106083503_recorded_run_quality/migration.sql",
		import.meta.url,
	),
	"utf8",
).replace(/\s+/g, " ");
describe("recorded run quality migration", () => {
	it("is additive and passes migration lint without waivers", () => {
		expect(
			lintMigration({
				migration: "20261106083503_recorded_run_quality",
				sql,
				preExistingTables: new Set([
					"workflow",
					"workflow_execution",
					"agent_template_instance",
					"agent_deployment_execution",
				]),
			}),
		).toEqual([]);
		expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM)\b/);
	});
	it.each(["run_quality_policy", "run_quality_assessment"])(
		"forces actor-within-org RLS on %s",
		(table) => {
			expect(sql).toContain(
				`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
			);
			expect(sql).toContain(
				`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
			);
			expect(sql).toContain(
				`CREATE POLICY tenant_isolation ON ${table} USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id()) WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())`,
			);
		},
	);
	it("pins source native execution, tenant, actor and policy target", () => {
		for (const text of [
			'e."organizationId"=NEW."organizationId"',
			'e."userId"=NEW."userId"',
			'e."workflowId"=p."workflowId"',
			"e.metadata#>>'{fabricAdmission,dispatch,instanceId}'=p.\"instanceId\"",
			'e."runId"=NEW."nativeRunId"',
			"Quality admission is immutable",
			"Quality policy target is immutable",
		])
			expect(sql).toContain(text);
	});
	it("bounds rule arrays without SQL short-circuit assumptions", () => {
		expect(sql).toContain(
			`CASE WHEN jsonb_typeof("rulesJson") = 'array' THEN jsonb_array_length("rulesJson") BETWEEN 1 AND 20 ELSE false END`,
		);
		expect(sql).toContain("run_quality_assessment_state");
		expect(sql).toContain("run_quality_assessment_source_xor");
		expect(sql).toContain("run_quality_policy_target_xor");
	});
	it("allows only minimized evidence fields", () => {
		for (const text of [
			"Quality sources contain unsupported fields",
			"Quality check has invalid shape",
			"Quality verdict requires evidence",
			"ARRAY['kind','index','passed','available']",
			"ARRAY['version','scorerVersion','rules','coverage']",
		])
			expect(sql).toContain(text);
	});
});

const forward = readFileSync(
	new URL(
		"../prisma/migrations/20261106100830_quality_report_compatibility/migration.sql",
		import.meta.url,
	),
	"utf8",
).replace(/\s+/g, " ");
it("preserves admitted historical source identities while allowing terminalization after parent reset", () => {
	expect(forward).toContain(
		"CREATE OR REPLACE FUNCTION public.enforce_run_quality_assessment_scope()",
	);
	expect(forward).toContain(
		`IF TG_OP='INSERT' AND NEW."agentExecutionId" IS NOT NULL`,
	);
	expect(forward).toContain(
		`IF TG_OP='INSERT' AND NEW."workflowExecutionId" IS NOT NULL`,
	);
	expect(forward).toContain("Quality admission is immutable");
	expect(forward).toContain("Quality terminal evidence is immutable");
	expect(forward).toContain(
		"IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public",
	);
});
