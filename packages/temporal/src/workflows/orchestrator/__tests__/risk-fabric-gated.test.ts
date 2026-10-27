/**
 * A scheduled workflow is described in words people use for schedules: "every
 * Monday", "all open items", "remove duplicates". The loop's keyword scan read
 * those as a bulk modify and held `fabric_create_workflow` for a generic
 * "modify multiple items" approval — on top of the real one, which the activity
 * asks for when a workflow tool writes (the runtime authority round).
 *
 * `fabric-gated-v2` leaves the scan off for the workflow tools the loop sends
 * to the Fabric catalog and changes nothing else. The loop picks it behind its
 * own patch marker, so a recorded history replays with the rules it was made
 * with; that gate is asserted from source, because importing the workflow
 * module pulls in the Temporal sandbox.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "../../../lib/fabric-workflow-tool-definitions";
import {
	type AutonomyLevel,
	assessToolCallRisk,
	type RiskAssessmentOptions,
} from "../risk-assessment";

const V1: RiskAssessmentOptions = {
	rules: "read-only-exempt-v1",
	fabricRouted: true,
};
const V2: RiskAssessmentOptions = {
	rules: "fabric-gated-v2",
	fabricRouted: true,
};
const V2_THIRD_PARTY: RiskAssessmentOptions = {
	rules: "fabric-gated-v2",
	fabricRouted: false,
};
const LEVELS: AutonomyLevel[] = ["CONSERVATIVE", "BALANCED", "AUTONOMOUS"];

const scheduledDigest = {
	name: "fabric_create_workflow",
	args: {
		preset: {
			name: "Every Monday status page",
			cron: "0 9 * * 1",
			prompt: "Summarise all open work items, remove duplicates and publish a status page",
		},
	},
};

describe("the reported false positive", () => {
	it("was held for approval under the earlier rules", () => {
		expect(
			assessToolCallRisk(scheduledDigest, "BALANCED", V1),
		).toMatchObject({ riskLevel: "critical", requiresApproval: true });
	});

	it.each(LEVELS)("asks nothing of the scan under %s", (level) => {
		expect(assessToolCallRisk(scheduledDigest, level, V2)).toEqual({
			riskLevel: "low",
			requiresApproval: false,
			reason: "Approval is asked where fabric_create_workflow runs",
		});
	});

	it.each(
		FABRIC_WORKFLOW_TOOL_DEFINITIONS.map((definition) => definition.name),
	)("%s is not scanned when sent to the Fabric catalog", (name) => {
		expect(
			assessToolCallRisk(
				{ name, args: { workflowId: "wf-1", note: "delete all" } },
				"CONSERVATIVE",
				V2,
			).requiresApproval,
		).toBe(false);
	});
});

describe("nothing else changes", () => {
	it("a workflow tool name on another MCP server is still scanned", () => {
		expect(
			assessToolCallRisk(scheduledDigest, "BALANCED", V2_THIRD_PARTY),
		).toMatchObject({ riskLevel: "critical", requiresApproval: true });
	});

	it("a Fabric write that is not a workflow tool is still scanned", () => {
		expect(
			assessToolCallRisk(
				{
					name: "fabric_create_story",
					args: { title: "Remove all drafts" },
				},
				"BALANCED",
				V2,
			),
		).toMatchObject({ riskLevel: "critical", requiresApproval: true });
	});

	it("a delete tool still needs approval", () => {
		expect(
			assessToolCallRisk(
				{ name: "delete_issue", args: { id: "ISSUE-1" } },
				"BALANCED",
				V2,
			),
		).toMatchObject({ riskLevel: "high", requiresApproval: true });
	});

	it.each(["constructor", "toString", "hasOwnProperty"])(
		"the name %s is not a workflow tool",
		(name) => {
			expect(
				assessToolCallRisk(
					{ name, args: { action: "delete", scope: "all" } },
					"BALANCED",
					V2,
				),
			).toMatchObject({ riskLevel: "critical", requiresApproval: true });
		},
	);

	it.each([
		{ name: "fabric_create_story", args: { title: "Remove all drafts" } },
		{ name: "project_rag_query", args: { query: "unclear risks" } },
		{ name: "create_issue", args: { title: "Login fails" } },
		{ name: "delete_issue", args: { id: "ISSUE-1" } },
	])("decides $name as the earlier rules did", (call) => {
		for (const level of LEVELS) {
			expect(assessToolCallRisk(call, level, V2)).toEqual(
				assessToolCallRisk(call, level, V1),
			);
		}
	});

	it("keeps holding the same call under the legacy rules a recorded history was made with", () => {
		expect(
			assessToolCallRisk(scheduledDigest, "BALANCED", {
				rules: "legacy",
			}),
		).toMatchObject({ riskLevel: "critical", requiresApproval: true });
	});
});

describe("replay safety", () => {
	const source = readFileSync(
		join(
			process.cwd(),
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		),
		"utf-8",
	);

	it("picks the new rules only behind their own marker, inside the one the earlier rules sit behind", () => {
		expect(source).toMatch(
			/const riskOptions:\s*RiskAssessmentOptions\s*=\s*patched\(\s*"orch-risk-read-only-exempt-v1",?\s*\)\s*\?\s*\{\s*rules: patched\(\s*"orch-risk-fabric-gated-v1",?\s*\)\s*\?\s*"fabric-gated-v2"\s*:\s*"read-only-exempt-v1",/,
		);
		expect(source).toMatch(
			/:\s*\{ rules: "legacy" \};\s*let riskAssessment = assessToolCallRisk\(\s*toolCall,\s*autonomyLevel,\s*riskOptions,?\s*\)/,
		);
	});

	it("takes the routing from the loop's dispatch for the new rules too", () => {
		expect(source).toMatch(
			/fabricRouted:\s*isLoopBuiltInReadTool\(toolCall\.name\) \|\|\s*discoveredToolConfigIds\[toolCall\.name\] ===\s*FABRIC_AI_SERVER_CONFIG_ID,/,
		);
	});
});
