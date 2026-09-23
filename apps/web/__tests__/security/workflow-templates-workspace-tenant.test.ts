/**
 * The workflow-templates stream route starts a workflow with the workspace ids
 * an agent instance stores. The instance row is tenant-checked when it is
 * loaded, but the ids on it are not: instances saved before instance writes
 * bound workspaces to the instance's organization can name another
 * organization's workspace. The route must narrow them to the request's tenant
 * with `filterWorkspaceIdsForTenant` before they reach the workflow input, so
 * a foreign id never lands in the workflow's history.
 *
 * The filter's rule is unit-tested in `@repo/database`; these assertions pin
 * the route to it so a refactor cannot quietly go back to passing the stored
 * list straight through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE = join(
	process.cwd(),
	"app/api/agents/workflow-templates/stream/route.ts",
);

describe("workflow-templates stream workspace tenancy", () => {
	const source = readFileSync(ROUTE, "utf-8");
	const callAt = source.indexOf("filterWorkspaceIdsForTenant({");
	const call = source.slice(callAt, source.indexOf("});", callAt) + 3);
	const startAt = source.indexOf("temporalClient.workflow.start(");

	it("imports the tenant filter from @repo/database", () => {
		expect(source).toMatch(
			/import\s*\{[^}]*\bfilterWorkspaceIdsForTenant\b[^}]*\}\s*from\s*"@repo\/database"/,
		);
	});

	it("reads the instance's stored ids only as the filter's input, bound to the request's tenant", () => {
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
});
