/**
 * The per-tool-call risk gate held a read-only search for "delete" approval
 * for ten minutes: `project_rag_query` with a query mentioning "unclear
 * risks" matched the DESTRUCTIVE keyword "clear" as a substring of the
 * serialized arguments (Fizzy #2578).
 *
 * `read-only-exempt-v1`:
 * - never scans a Fabric-owned read — one the loop runs itself or routes to
 *   the Fabric catalog. A same-named tool on another MCP server is scanned.
 * - keeps substring matching on the tool name, so `bulkdelete` is a delete.
 * - matches arguments by word, with inflections, so "deleted" counts and
 *   "unclear" does not.
 *
 * The loop picks it behind a patch marker, so a recorded history — whose
 * approval activities were scheduled by the old decision — replays with the
 * old rules; that gate is asserted from source, because importing the
 * workflow module pulls in the Temporal sandbox.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFabricCatalogRoute } from "../../../activities/orchestrator/execution/fabric-catalog-adapter";
import { isFabricOwnedRead } from "../fabric-catalog-access";
import {
	type AutonomyLevel,
	assessToolCallRisk,
	type RiskAssessmentOptions,
	type ToolCallForRisk,
} from "../risk-assessment";

const FABRIC: RiskAssessmentOptions = {
	rules: "read-only-exempt-v1",
	fabricRouted: true,
};
const THIRD_PARTY: RiskAssessmentOptions = {
	rules: "read-only-exempt-v1",
	fabricRouted: false,
};
const LEVELS: AutonomyLevel[] = ["CONSERVATIVE", "BALANCED", "AUTONOMOUS"];

const ragSearch = {
	name: "project_rag_query",
	args: {
		query: "unclear risks, items removed from scope, archive all, reset address",
	},
};

describe("the reported false positive", () => {
	it("was gated under the legacy rules", () => {
		expect(assessToolCallRisk(ragSearch, "BALANCED")).toMatchObject({
			riskLevel: "critical",
			requiresApproval: true,
		});
	});

	it.each(LEVELS)("is a low-risk read under %s", (level) => {
		expect(assessToolCallRisk(ragSearch, level, FABRIC)).toEqual({
			riskLevel: "low",
			requiresApproval: false,
			reason: undefined,
		});
	});
});

// The independent review's table: each kept its legacy level under v1.
describe("real destructive calls keep their legacy level", () => {
	it.each<[ToolCallForRisk, "high" | "critical"]>([
		[{ name: "deletefile", args: { path: "a.txt" } }, "high"],
		[{ name: "bulkdelete", args: { ids: ["a"] } }, "critical"],
		[{ name: "removeall", args: {} }, "critical"],
		[{ name: "HTTPDelete", args: { url: "/x" } }, "high"],
		[{ name: "deletes_messages", args: { channel: "c1" } }, "high"],
		[{ name: "jira_update", args: { status: "deleted" } }, "high"],
	])("%o stays %s", (call, level) => {
		const legacy = assessToolCallRisk(call, "BALANCED");
		const v1 = assessToolCallRisk(call, "BALANCED", THIRD_PARTY);
		expect(legacy.riskLevel).toBe(level);
		expect(v1.riskLevel).toBe(level);
		expect(v1.requiresApproval).toBe(true);
	});

	it.each([
		["deleted", "high"],
		["deleting", "high"],
		["deletion", "high"],
		["removal", "high"],
		["removed", "high"],
		["archived", "high"],
		["cleared", "high"],
		["dropped", "high"],
		["erasure", "high"],
		["purges", "high"],
		["HTTPDelete", "high"],
		["removeAll", "critical"],
	])("an argument word '%s' reads as destructive", (word, level) => {
		expect(
			assessToolCallRisk(
				{ name: "jira_update", args: { note: word } },
				"BALANCED",
				THIRD_PARTY,
			).riskLevel,
		).toBe(level);
	});
});

describe("plain prose in arguments is not destructive", () => {
	it.each(["unclear", "address", "reset", "call", "small", "allocate"])(
		"'%s'",
		(word) => {
			expect(
				assessToolCallRisk(
					{ name: "jira_lookup", args: { text: word } },
					"CONSERVATIVE",
					THIRD_PARTY,
				),
			).toMatchObject({ riskLevel: "low", requiresApproval: false });
		},
	);

	it("splits acronyms and camelCase words where it always did", () => {
		// `XML_Delete_All`: an acronym, then camelCase.
		expect(
			assessToolCallRisk(
				{ name: "jira_update", args: { note: "XMLDeleteAll" } },
				"BALANCED",
				THIRD_PARTY,
			).riskLevel,
		).toBe("critical");
		// `API_Keys`: the split never lands inside a word.
		expect(
			assessToolCallRisk(
				{ name: "jira_lookup", args: { note: "APIKeys" } },
				"CONSERVATIVE",
				THIRD_PARTY,
			).riskLevel,
		).toBe("low");
	});

	it("reads an argument holding a long capital run in linear time", () => {
		// The acronym split used to rescan the run from each of its letters;
		// in the workflow that stalls the task past its timeout.
		const call = {
			name: "jira_lookup",
			args: { text: `${"A".repeat(60_000)}!` },
		};
		const started = performance.now();
		const result = assessToolCallRisk(call, "CONSERVATIVE", THIRD_PARTY);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(result).toMatchObject({
			riskLevel: "low",
			requiresApproval: false,
		});
	});

	it("the legacy rules keep substring matching for recorded histories", () => {
		expect(
			assessToolCallRisk(
				{ name: "jira_lookup", args: { text: "unclear" } },
				"BALANCED",
			),
		).toMatchObject({ riskLevel: "high", requiresApproval: true });
	});
});

describe("only Fabric-owned reads skip the scan", () => {
	it.each([
		"project_rag_query",
		"workspace_rag_query",
		"search_tools",
		"search_slack_messages",
		"search_teams_messages",
		"fabric_list_meeting_transcripts",
		"code_search",
		"code_search_semantic",
		"code_file_get",
		"fabric_list_project_documents",
		"fabric_get_project_document",
		"fabric_list_project_sources",
		"fabric_get_project_source",
		"fabric_list_project_features",
		"fabric_get_x",
		"x_rag_query",
	])("%s routed to Fabric", (name) => {
		expect(isFabricOwnedRead(name, true)).toBe(true);
		expect(
			assessToolCallRisk(
				{ name, args: { query: "delete all the removed items" } },
				"CONSERVATIVE",
				FABRIC,
			).requiresApproval,
		).toBe(false);
	});

	// A user's MCP server can name its tools anything.
	it.each([
		"fabric_get_x",
		"x_rag_query",
		"code_search",
		"project_rag_query",
	])(
		"a third-party %s with a destructive argument still needs approval",
		(name) => {
			expect(isFabricOwnedRead(name, false)).toBe(false);
			expect(
				assessToolCallRisk(
					{ name, args: { action: "delete", scope: "all" } },
					"BALANCED",
					THIRD_PARTY,
				),
			).toMatchObject({ riskLevel: "critical", requiresApproval: true });
		},
	);

	it("takes the catalog's own READ declarations, so the two cannot disagree", () => {
		for (const name of [
			"fabric_list_project_documents",
			"fabric_get_project_source",
			"code_tree",
		]) {
			expect(resolveFabricCatalogRoute(name)?.access).toBe("READ");
			expect(isFabricOwnedRead(name, true)).toBe(true);
		}
		expect(resolveFabricCatalogRoute("fabric_create_story")?.access).toBe(
			"WRITE",
		);
		expect(isFabricOwnedRead("fabric_create_story", true)).toBe(false);
	});

	it.each([
		"fabric_get_or_create_page",
		"fabric_list_and_delete_items",
		"search_and_replace",
		"delete_project",
		"fabric_update_document",
	])("a write-shaped name is not exempt even from Fabric: %s", (name) => {
		expect(isFabricOwnedRead(name, true)).toBe(false);
	});
});

describe("writes are still gated", () => {
	it("a delete tool needs approval under BALANCED", () => {
		expect(
			assessToolCallRisk(
				{ name: "delete_issue", args: { id: "ISSUE-1" } },
				"BALANCED",
				FABRIC,
			),
		).toMatchObject({ riskLevel: "high", requiresApproval: true });
	});

	it("a single create is medium, approved only when CONSERVATIVE", () => {
		const call = { name: "create_issue", args: { title: "Login fails" } };
		expect(assessToolCallRisk(call, "BALANCED", FABRIC)).toMatchObject({
			riskLevel: "medium",
			requiresApproval: false,
		});
		expect(
			assessToolCallRisk(call, "CONSERVATIVE", FABRIC).requiresApproval,
		).toBe(true);
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

	it("picks the new rules only behind their patch marker", () => {
		expect(source).toMatch(
			/assessToolCallRisk\(\s*toolCall,\s*autonomyLevel,\s*patched\("orch-risk-read-only-exempt-v1"\)\s*\?\s*\{\s*rules: "read-only-exempt-v1",/,
		);
		expect(source).toMatch(/:\s*\{ rules: "legacy" \},?\s*\)/);
	});

	it("takes the routing from the loop's dispatch, not from the name alone", () => {
		expect(source).toMatch(
			/fabricRouted:\s*isLoopBuiltInReadTool\(toolCall\.name\) \|\|\s*discoveredToolConfigIds\[toolCall\.name\] ===\s*FABRIC_AI_SERVER_CONFIG_ID,/,
		);
	});

	it("defaults to the legacy rules when none are named", () => {
		expect(assessToolCallRisk(ragSearch)).toEqual(
			assessToolCallRisk(ragSearch, "BALANCED", { rules: "legacy" }),
		);
	});
});
