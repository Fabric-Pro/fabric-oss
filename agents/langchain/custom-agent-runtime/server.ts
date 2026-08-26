/**
 * Custom Agent Runtime Server
 *
 * A multi-tenant runtime that hosts user-created custom agents with A2A protocol support.
 * Port: 8240 (A2A protocol)
 *
 * Note: This is a placeholder implementation. The full implementation with database
 * integration will be added when the module resolution issues are resolved.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8240", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Create Hono app
const app = new Hono();

// Enable CORS
app.use("*", cors());

// Health check
app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		service: "custom-agent-runtime",
		protocol: "a2a",
		version: "0.3.0",
		message:
			"Custom agent runtime is ready. Agent loading requires database configuration.",
	});
});

// List agents (placeholder)
app.get("/agents", (c) => {
	return c.json({
		agents: [],
		message: "Custom agents will be loaded from database when configured.",
	});
});

// Agent Card endpoint (v0.3.0)
app.get("/agents/:agentId/.well-known/agent-card.json", async (c) => {
	const agentId = c.req.param("agentId");

	return c.json({
		name: agentId,
		description: `Custom agent ${agentId}`,
		url: `${BASE_URL}/agents/${agentId}`,
		protocolVersion: "0.3.0",
		capabilities: {
			streaming: false,
			pushNotifications: false,
			stateTransitionHistory: true,
		},
		skills: [
			{
				id: `${agentId}-main`,
				name: agentId,
				description: `Custom agent ${agentId}`,
				tags: ["custom"],
			},
		],
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
	});
});

// Agent Card endpoint (legacy)
app.get("/agents/:agentId/.well-known/agent.json", async (c) => {
	const agentId = c.req.param("agentId");

	// Return a placeholder agent card
	return c.json({
		name: agentId,
		description: `Custom agent ${agentId}`,
		url: `${BASE_URL}/agents/${agentId}`,
		protocolVersion: "0.3.0",
		capabilities: {
			streaming: false,
			pushNotifications: false,
			stateTransitionHistory: true,
		},
		skills: [
			{
				id: `${agentId}-main`,
				name: agentId,
				description: `Custom agent ${agentId}`,
				tags: ["custom"],
			},
		],
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
	});
});

// A2A Send endpoint (placeholder)
app.post("/agents/:agentId/a2a/send", async (c) => {
	const agentId = c.req.param("agentId");

	try {
		const body = await c.req.json();
		const taskId = uuidv4();

		const message = body.message?.parts?.find(
			(p: { type: string }) => p.type === "text",
		);
		const userMessage = message?.text || "";

		console.log(
			`[CustomRuntime] Received message for ${agentId}:`,
			userMessage.substring(0, 100),
		);

		return c.json({
			id: taskId,
			sessionId: body.sessionId || uuidv4(),
			status: {
				state: "completed",
				timestamp: new Date().toISOString(),
			},
			history: [
				{
					role: "agent",
					parts: [
						{
							type: "text",
							text: `[Custom Agent Runtime] Agent ${agentId} is not configured. Please create a custom agent in the Agent Registry.`,
						},
					],
				},
			],
			artifacts: [],
		});
	} catch (error) {
		console.error(`[CustomRuntime] Error for ${agentId}:`, error);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// Agent health check
app.get("/agents/:agentId/health", (c) => {
	const agentId = c.req.param("agentId");

	return c.json({
		status: "healthy",
		agent: agentId,
		protocol: "a2a",
		version: "0.3.0",
	});
});

// Start the server
console.log(`[CustomRuntime] Starting Custom Agent Runtime on ${HOST}:${PORT}`);
console.log(`[CustomRuntime] Health: ${BASE_URL}/health`);

serve({
	fetch: app.fetch,
	hostname: HOST,
	port: PORT,
});

export { app };
