/**
 * Pattern route
 *
 * Multi-node LangGraph agent for plan creation
 */

import { HumanMessage } from "@langchain/core/messages";
import { Hono } from "hono";
import { patternGraph } from "./agent.js";

export const patternRoute = new Hono();

patternRoute.post("/", async (c) => {
	try {
		const { message, metadata } = await c.req.json();
		const { tenantContext, projectContext, planId } = metadata;

		if (!tenantContext || !projectContext) {
			return c.json(
				{
					error: "Missing required metadata: tenantContext and projectContext",
				},
				400,
			);
		}

		// Invoke Pattern LangGraph. The reporting credential (issued per
		// delegation by the orchestrator) rides in configurable so nodes can
		// attribute usage to this run's actor (Fizzy #1894).
		const result = await patternGraph.invoke(
			{
				messages: [
					new HumanMessage(message.parts?.[0]?.text || message),
				],
				projectContext,
				tenantContext,
				planId,
			},
			{
				configurable: {
					ai_token:
						typeof metadata.aiToken === "string"
							? metadata.aiToken
							: undefined,
					tenant_user_id: tenantContext.userId,
					tenant_organization_id:
						tenantContext.organizationId ?? undefined,
					project_id: projectContext.projectId,
				},
			},
		);

		return c.json({
			success: true,
			planId: result.planId,
			checkboxes: result.checkboxes,
			analysis: result.analysis,
		});
	} catch (error) {
		console.error("Pattern error:", error);
		return c.json(
			{
				error: error instanceof Error ? error.message : "Unknown error",
				stack:
					process.env.NODE_ENV === "development"
						? error instanceof Error
							? error.stack
							: undefined
						: undefined,
			},
			500,
		);
	}
});

// Health check
patternRoute.get("/health", (c) => {
	return c.json({
		status: "healthy",
		agent: "pattern",
		workflow: "research → analyze → create → save",
		capabilities: ["plan_creation", "research_integration"],
	});
});
