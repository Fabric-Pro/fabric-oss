/**
 * Where the AI calls of a workflow an MCP tool starts run (Fizzy #2770): a
 * member signed in to the server in the browser runs on their own ChatGPT
 * plan; every key or token runs as background work on the organization's
 * shared plans.
 */
import { mcpWorkflowAiRouting } from "@saas/mcp/lib/gateway/workflow-ai-routing";
import { describe, expect, it } from "vitest";

describe("mcpWorkflowAiRouting", () => {
	it("marks a signed-in member's run plan-eligible", () => {
		expect(mcpWorkflowAiRouting("session")).toEqual({ planEligible: true });
	});

	it.each(["organization-key", "personal-key", "oauth"] as const)(
		"runs a %s caller's workflow as public-API background work",
		(credential) => {
			expect(mcpWorkflowAiRouting(credential)).toEqual({
				jobType: "public-api",
			});
		},
	);
});
