/**
 * weave-readers service
 *
 * Tier 1 agents with read-only sandbox access:
 * - Thread: Codebase exploration
 * - Spindle: External research
 * - Weft: Quality review
 * - Warp: Security audit
 */

import { serve } from "@hono/node-server";
import { serviceAuth } from "@repo/agent-runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { a2aRoute } from "./routes/a2a.js";
import { healthRoute } from "./routes/health.js";
import { spindleRoute } from "./routes/spindle.js";
import { threadRoute } from "./routes/thread.js";
import { warpRoute } from "./routes/warp.js";
import { weftRoute } from "./routes/weft.js";

const app = new Hono();
const PORT = Number(process.env.PORT || "8140");

// Middleware
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

// HMAC-verified service authentication — rejects unsigned or invalid tenant contexts
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

// Routes
app.route("/thread", threadRoute);
app.route("/spindle", spindleRoute);
app.route("/weft", weftRoute);
app.route("/warp", warpRoute);
app.route("/health", healthRoute);

// A2A Agent Card — required for orchestrator discovery
const AGENT_CARD = {
	name: "weave_readers",
	description:
		"Fabric Weave reader agents: Thread (codebase exploration), Spindle (research), Weft (quality review), Warp (security audit). All agents have read-only sandbox access.",
	url: process.env.BASE_URL || `http://localhost:${PORT}`,
	protocolVersion: "0.3.0",
	capabilities: {
		streaming: true,
		pushNotifications: false,
		stateTransitionHistory: true,
		multiTenancyAware: true,
	},
	skills: [
		{
			id: "weave-thread",
			name: "Thread — Codebase Explorer",
			description:
				"Explores and maps the codebase structure, dependencies, and architecture",
			tags: ["codebase", "exploration", "read-only"],
		},
		{
			id: "weave-spindle",
			name: "Spindle — Research",
			description:
				"Researches external documentation, APIs, and best practices",
			tags: ["research", "documentation", "read-only"],
		},
		{
			id: "weave-weft",
			name: "Weft — Quality Review",
			description: "Reviews code quality, tests, and coding standards",
			tags: ["quality", "review", "testing", "read-only"],
		},
		{
			id: "weave-warp",
			name: "Warp — Security Audit",
			description:
				"Audits code for security vulnerabilities and compliance issues",
			tags: ["security", "audit", "compliance", "read-only"],
		},
	],
	defaultInputModes: ["text"],
	defaultOutputModes: ["text"],
};

app.get("/.well-known/agent.json", (c) => c.json(AGENT_CARD));
app.get("/.well-known/agent-card.json", (c) => c.json(AGENT_CARD));

// A2A protocol — routes messages to the correct reader agent and returns JSON
app.route("/a2a", a2aRoute);

// Start server
console.log(`🧵 weave-readers starting on port ${PORT}`);
serve({
	fetch: app.fetch,
	port: PORT,
});

export default app;
