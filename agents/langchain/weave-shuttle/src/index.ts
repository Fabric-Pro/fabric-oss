/**
 * weave-shuttle service
 *
 * Category-specific implementation with write access.
 * Separate service for security boundary (write access isolation).
 */

import { serve } from "@hono/node-server";
import { serviceAuth } from "@repo/agent-runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { a2aRoute } from "./routes/a2a.js";
import { shuttleRoute } from "./routes/shuttle.js";

const app = new Hono();
const PORT = Number(process.env.PORT || "8141");

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

app.route("/shuttle", shuttleRoute);

// A2A Agent Card — required for orchestrator discovery
const AGENT_CARD = {
	name: "weave_shuttle",
	description:
		"Fabric Weave Shuttle agent — writes and modifies code files with full write access. Isolated service for security boundary enforcement.",
	url: process.env.BASE_URL || `http://localhost:${PORT}`,
	protocolVersion: "0.3.0",
	capabilities: {
		streaming: true,
		pushNotifications: false,
		stateTransitionHistory: true,
		multiTenancyAware: true,
		codeExecution: true,
	},
	skills: [
		{
			id: "weave-shuttle",
			name: "Shuttle — Code Writer",
			description:
				"Implements code changes, creates new files, and modifies existing ones based on the weave plan",
			tags: ["code-writing", "implementation", "file-modification"],
		},
	],
	defaultInputModes: ["text"],
	defaultOutputModes: ["text"],
};

// A2A protocol — accepts tasks and returns JSON results
app.route("/a2a", a2aRoute);

app.get("/.well-known/agent.json", (c) => c.json(AGENT_CARD));
app.get("/.well-known/agent-card.json", (c) => c.json(AGENT_CARD));

app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		service: "weave-shuttle",
		timestamp: new Date().toISOString(),
	});
});

console.log(`🚀 weave-shuttle starting on port ${PORT}`);
serve({
	fetch: app.fetch,
	port: PORT,
});

export default app;
