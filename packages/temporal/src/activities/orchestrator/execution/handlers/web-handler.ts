/**
 * Web Handler
 *
 * Handles steps that require web browsing/scraping capabilities.
 * Routes to appropriate browser agents or web scraping tools.
 */

import type { ExecuteStepInput } from "../../types";
import type { HandlerContext, HandlerResult, StepHandler } from "./types";

export class WebHandler implements StepHandler {
	readonly name = "web";
	readonly capabilities = ["web"];

	canHandle(input: ExecuteStepInput): boolean {
		const capability = input.step.capability || "mcp_tool";
		const app = input.step.app;

		// Only handle web capability when not delegating to a browser agent
		// Browser agent delegation is handled by AgentHandler
		if (capability === "web") {
			// If it's a browser agent, let AgentHandler handle it
			if (app === "cuga_generalist" || app === "browser_agent") {
				return false;
			}
			// If it's a Firecrawl tool, let MCP handler handle it
			if (app?.startsWith("firecrawl")) {
				return false;
			}
			// Otherwise, this is a generic web capability request
			return true;
		}
		return false;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		console.log(
			`[WebHandler] Web capability requested for step: ${input.step.id}`,
		);

		const app = input.step.app;

		// Log routing decision
		if (app) {
			console.log(`[WebHandler] Step app specified: ${app}`);
		}

		// For generic web capability without a specific app,
		// fall back to MCP tools (which may include Firecrawl)
		return {
			handled: false,
			shouldFallback: true,
			fallbackReason:
				"Generic web capability, falling back to MCP tools for execution",
		};
	}
}
