import type { AiJobKey } from "@repo/ai";
import type { GatewayCredential } from "./types";

export type McpWorkflowAiRouting =
	| { planEligible: true }
	| { jobType: Extract<AiJobKey, "public-api"> };

/**
 * Where the AI calls of a workflow an MCP tool starts run (Fizzy #2770),
 * spread onto the workflow's input. A member signed in to the server in the
 * browser is doing their own work, so the run is plan-eligible and may use
 * their ChatGPT plan. Any key or token is an unattended caller, and an
 * organization key acts as the member who created it: its run is background
 * work on the organization's shared plans, never on that member's own.
 */
export function mcpWorkflowAiRouting(
	credential: GatewayCredential,
): McpWorkflowAiRouting {
	return credential === "session"
		? { planEligible: true }
		: { jobType: "public-api" };
}
