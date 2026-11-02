/**
 * A workflow-template run (the stream route's, and the agent runtime's
 * deep-researcher engine's) starts a workflow with the workspace ids an
 * agent instance stores. An organization's instance is readable by any of
 * its members, and the ids on it are not checked when it is loaded: some
 * name workspaces the caller cannot open, and rows saved before instance
 * writes bound workspaces to the instance's organization can name another
 * organization's. The shared admission must narrow them with
 * `filterAccessibleWorkspaceIds` (the tenant rule, then the caller's access)
 * before they reach the workflow input, so neither lands in its history.
 *
 * The filter's rule is unit-tested in `@repo/database`; these assertions pin
 * the admission to it so a refactor cannot quietly go back to the
 * tenancy-only filter or to passing the stored list straight through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE = join(
	process.cwd(),
	"app/api/agents/workflow-templates/workflow-template-run.ts",
);
const STREAM_ROUTE = join(
	process.cwd(),
	"app/api/agents/workflow-templates/stream/route.ts",
);
const RESEARCH_ENGINE = join(
	process.cwd(),
	"modules/saas/agents/runtime/research-engine.ts",
);

describe("workflow-template run workspace access", () => {
	const source = readFileSync(ROUTE, "utf-8");
	const callAt = source.indexOf("filterAccessibleWorkspaceIds({");
	const call = source.slice(callAt, source.indexOf("});", callAt) + 3);
	const startAt = source.indexOf("temporalClient.workflow.start(");

	it("imports the access filter from @repo/database, not the tenancy-only one", () => {
		expect(source).toMatch(
			/import\s*\{[^}]*\bfilterAccessibleWorkspaceIds\b[^}]*\}\s*from\s*"@repo\/database"/,
		);
		expect(source).not.toContain("filterWorkspaceIdsForTenant");
	});

	it("reads the instance's stored ids only as the filter's input, bound to the caller and the request's tenant", () => {
		expect(callAt).toBeGreaterThan(-1);
		expect(source.split("instance.workspaceIds").length - 1).toBe(1);
		expect(call).toContain("workspaceIds: instance.workspaceIds");
		expect(call).toMatch(/\buserId\b/);
		expect(call).toContain("organizationId: organizationId ?? null");
	});

	it("feeds only the filtered ids to the workflow, before it starts", () => {
		const assignments = source.match(/\binstanceWorkspaceIds\s*=[^=]/g);
		expect(assignments).toHaveLength(1);
		const assignAt = source.indexOf("instanceWorkspaceIds = allowed;");
		expect(assignAt).toBeGreaterThan(callAt);
		expect(startAt).toBeGreaterThan(assignAt);
	});

	it("the stream route and the research engine both use admitWorkflowTemplateRun, and neither filters workspaces nor starts the workflow itself", () => {
		for (const file of [STREAM_ROUTE, RESEARCH_ENGINE]) {
			const caller = readFileSync(file, "utf-8");
			expect(caller).toMatch(/\badmitWorkflowTemplateRun\(/);
			expect(caller).toMatch(/\bstartDeepResearcherWorkflow\(/);
			expect(caller).not.toMatch(
				/filterAccessibleWorkspaceIds|filterWorkspaceIdsForTenant/,
			);
			expect(caller).not.toContain("instance.workspaceIds");
			expect(caller).not.toContain("workflow.start(");
		}
	});
});
