/**
 * The Orchestrator carries the turn's acting grant to the activity that calls
 * Fabric MCP, behind its own replay marker.
 *
 * The workflow only carries the grant its web route minted; the activity input
 * is where it reaches `executeMcpTool`. Dropping the spread leaves every
 * activity test, which sets the field by hand, green while every Fabric tool in
 * an Orchestrator turn is refused at the gateway. The marker keeps a history
 * recorded before the field existed replaying with the input it was recorded
 * with.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf-8");
}

describe("the Orchestrator's acting grant", () => {
	it("goes to the tool activity only behind its own patch marker", () => {
		const source = readSource(
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		);

		expect(source).toMatch(
			/\.\.\.\(patched\("orch-fabric-acting-grant-v1"\)\s*\?\s*\{\s*actingGrant: input\.actingGrant,\s*launchWorkspaceId: input\.launchWorkspaceId,\s*launchSurface: input\.launchSurface,\s*\}\s*:\s*\{\}\)/,
		);
	});

	it("is a field of the workflow input and of the activity input", () => {
		const workflowInput = readSource(
			"src/workflows/orchestrator/types/workflow-io.types.ts",
		);
		const activityInput = readSource(
			"src/activities/orchestrator/types.ts",
		);

		for (const field of [
			"actingGrant",
			"launchWorkspaceId",
			"launchSurface",
		]) {
			expect(workflowInput, field).toContain(`${field}?:`);
			expect(activityInput, field).toContain(`${field}?:`);
		}
	});
});
