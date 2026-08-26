import { describe, expect, it } from "vitest";
import {
	analyzePMToolCapabilities,
	type McpToolDefinition,
} from "../tool-analyzer";

const idOnlySchema = (idParam: string, extra: string[] = []) => ({
	type: "object",
	properties: Object.fromEntries(
		[idParam, ...extra].map((p) => [p, { type: "string" }]),
	),
	required: [idParam, ...extra],
});

describe("analyzePMToolCapabilities — taskComments", () => {
	it("detects ADO wit_get_work_item_comments without colliding with taskGet", () => {
		const tools: Record<string, McpToolDefinition> = {
			wit_get_work_item: {
				name: "wit_get_work_item",
				inputSchema: idOnlySchema("workItemId"),
			},
			wit_get_work_item_comments: {
				name: "wit_get_work_item_comments",
				inputSchema: idOnlySchema("workItemId"),
			},
		};
		const caps = analyzePMToolCapabilities(tools, {
			serverHint: "azure-devops",
		});
		expect(caps.taskGet?.toolName).toBe("wit_get_work_item");
		expect(caps.taskComments?.toolName).toBe("wit_get_work_item_comments");
		expect(caps.taskComments?.idParam).toBe("workItemId");
	});

	it("detects Fizzy get_card_comments (card_id + account_slug) distinct from get_card", () => {
		const tools: Record<string, McpToolDefinition> = {
			get_card: {
				name: "get_card",
				inputSchema: idOnlySchema("card_number"),
			},
			get_card_comments: {
				name: "get_card_comments",
				inputSchema: idOnlySchema("card_id", ["account_slug"]),
			},
		};
		const caps = analyzePMToolCapabilities(tools, { serverHint: "fizzy" });
		expect(caps.taskGet?.toolName).toBe("get_card");
		expect(caps.taskComments?.toolName).toBe("get_card_comments");
		expect(caps.taskComments?.idParam).toBe("card_id");
		expect(caps.taskComments?.additionalRequiredParams).toContain(
			"account_slug",
		);
	});

	it("returns undefined taskComments when no comments tool is present", () => {
		const tools: Record<string, McpToolDefinition> = {
			get_issue: {
				name: "get_issue",
				inputSchema: idOnlySchema("issue_id"),
			},
		};
		const caps = analyzePMToolCapabilities(tools);
		expect(caps.taskComments).toBeUndefined();
	});
});
