/**
 * weave-planners service
 *
 * Multi-node LangGraph agents for complex planning workflows
 */

import { serve } from "@hono/node-server";
import { HumanMessage } from "@langchain/core/messages";
import { serviceAuth } from "@repo/agent-runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { patternGraph } from "./pattern/agent.js";
import { patternRoute } from "./pattern/route.js";

const app = new Hono();
const PORT = Number(process.env.PORT || "8142");

app.use("*", logger());
app.use(
	"*",
	cors({
		origin: process.env.CORS_ALLOWED_ORIGINS?.split(",") || [],
		allowMethods: ["POST", "GET", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"X-Tenant-User-ID",
			"X-Tenant-Org-ID",
			"X-Service-Token",
			"X-Tenant-Payload",
			"X-Tenant-Signature",
			"X-Tenant-Timestamp",
			"X-Source-Agent",
			"X-Request-ID",
		],
	}),
);

// HMAC-verified service authentication
// eslint-disable-next-line -- cast needed due to Hono patch version mismatch between packages
app.use(
	"*",
	serviceAuth({
		skipPaths: [
			"/health",
			"/.well-known/agent.json",
			"/.well-known/agent-card.json",
		],
		requireTenantContext: true,
	}) as never,
);

app.route("/pattern", patternRoute);

// A2A Send — standard protocol endpoint used by SecureA2AClient
app.post("/a2a/send", async (c) => {
	try {
		const body = await c.req.json();
		const message = body.message;

		// Extract metadata from message.metadata (set by create-plan procedure)
		const metadata = message?.metadata || body.metadata || {};
		const { tenantContext, projectContext, planId } = metadata;

		if (!tenantContext || !projectContext) {
			return c.json(
				{
					error: "Missing required metadata: tenantContext and projectContext",
				},
				400,
			);
		}

		const text = message?.parts?.[0]?.text || "";

		const result = await patternGraph.invoke({
			messages: [new HumanMessage(text)],
			projectContext,
			tenantContext,
			planId,
		});

		return c.json({
			success: true,
			planId: result.planId,
			checkboxes: result.checkboxes,
			analysis: result.analysis,
		});
	} catch (error) {
		console.error("[a2a/send] Pattern error:", error);
		return c.json(
			{
				error: error instanceof Error ? error.message : "Unknown error",
			},
			500,
		);
	}
});

// A2A Agent Card — required for orchestrator discovery
const AGENT_CARD = {
	name: "weave_planners",
	description:
		"Fabric Weave Pattern agent — multi-node LangGraph planner that decomposes tasks into structured weave plans with checkbox-based steps.",
	url: process.env.BASE_URL || `http://localhost:${PORT}`,
	protocolVersion: "0.3.0",
	capabilities: {
		streaming: true,
		pushNotifications: false,
		stateTransitionHistory: true,
		multiTenancyAware: true,
		taskDecomposition: true,
	},
	skills: [
		{
			id: "weave-pattern",
			name: "Pattern — Planner",
			description:
				"Decomposes complex software tasks into structured weave plans with ordered, reviewable steps",
			tags: ["planning", "decomposition", "weave-plan"],
		},
	],
	defaultInputModes: ["text"],
	defaultOutputModes: ["text"],
};

app.get("/.well-known/agent.json", (c) => c.json(AGENT_CARD));
app.get("/.well-known/agent-card.json", (c) => c.json(AGENT_CARD));

app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		service: "weave-planners",
		agents: ["pattern"],
		timestamp: new Date().toISOString(),
	});
});

console.log(`🧩 weave-planners starting on port ${PORT}`);
serve({
	fetch: app.fetch,
	port: PORT,
});

export default app;
