/**
 * Create Registered Agent Procedure
 *
 * Creates a new agent in the database-backed Agent Registry.
 *
 * Multi-Tenant Architecture:
 * - Agents are created instantly (no deployment needed)
 * - All agents use the shared runtime at agents.yourapp.com
 * - Each agent gets its own Durable Object instance
 * - Configuration is loaded from database at runtime
 *
 * Supports both internal (LangGraph) and external (A2A) agents.
 */

import { ORPCError } from "@orpc/server";
import { createId } from "@paralleldrive/cuid2";
import {
	extractAgentMetadata,
	hasRequiredEndpoints,
	safeValidateAgentMetadata,
	supportsAGUIProtocol,
	validateA2AEndpoint,
} from "@repo/agent-core";
import {
	createAgent,
	createRegisteredAgent as createExternalAgent,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";

// Extended framework schema to include A2A, MCP and COPILOTKIT for external agents
const ExtendedFrameworkSchema = z.enum([
	"LANGGRAPH",
	"PYDANTIC_AI",
	"OPENAI",
	"CREWAI",
	"AUTOGEN",
	"CUSTOM",
	"A2A",
	"MCP",
	"COPILOTKIT",
	"MICROSOFT",
	"ORCHESTRATOR",
]);

/**
 * Create a new registered agent
 */
export const createRegisteredAgent = protectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_CREATE))
	.route({
		method: "POST",
		path: "/agents/registry/create",
		tags: ["Agent Registry"],
		summary: "Create registered agent",
		description:
			"Create a new agent in the database-backed Agent Registry. Supports both internal (LangGraph) and external (A2A) agents.",
	})
	.input(
		z.object({
			name: z.string().min(1).max(100),
			displayName: z.string().min(1).max(200),
			description: z.string().optional(),
			framework: ExtendedFrameworkSchema.default("LANGGRAPH"),
			organizationId: z.string().nullable().optional(),
			scope: z.enum(["USER", "ORGANIZATION", "SYSTEM"]).optional(),
			config: z.any().optional(), // { model, temperature, mcpServers, capabilities, skills, etc. }
			metadata: z.any().optional(),
			deploymentUrl: z.string().url().optional(), // Required for A2A, optional for LangGraph
			validateProtocol: z.boolean().optional().default(false), // Validate AG-UI protocol
		}),
	)
	.output(
		z.object({
			id: z.string(),
			agentId: z.string(),
			name: z.string(),
			displayName: z.string(),
			description: z.string().nullable(),
			framework: z.string(),
			runtimeVersion: z.string().optional().nullable(),
			deploymentUrl: z.string().nullable(),
			status: z.string(),
			scope: z.string(),
			userId: z.string().nullable(),
			organizationId: z.string().nullable(),
			config: z.any().nullable(),
			metadata: z.any().nullable(),
			createdAt: z.date(),
			updatedAt: z.date(),
			lastHealthCheck: z.date().nullable(),
			lastDeployedAt: z.date().optional().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// SECURITY (SOC 2 CC6.1/CC6.3): a SYSTEM-scoped agent is visible to
		// and executed by EVERY tenant, with an attacker-controlled
		// deploymentUrl. Restrict SYSTEM creation to platform admins.
		// (requireInputOrgPermission above already verifies membership for
		// ORGANIZATION-scoped creates; SYSTEM agents have no org, so they
		// need this explicit gate.)
		if (input.scope === "SYSTEM" && context.user.role !== "admin") {
			throw new ORPCError("FORBIDDEN", {
				message: "Only platform admins can create SYSTEM-scoped agents",
			});
		}

		// Generate unique agentId
		const agentId =
			input.framework === "A2A"
				? `external-${input.name.toLowerCase().replace(/\s+/g, "-")}-${createId()}`
				: `${input.name}-${createId()}`;

		// Get LangGraph runtime URL from environment
		const langGraphRuntimeUrl =
			process.env.LANGGRAPH_RUNTIME_URL || "http://localhost:8125";

		console.log("[createRegisteredAgent] Creating agent:", {
			agentId,
			name: input.name,
			displayName: input.displayName,
			framework: input.framework,
			scope: input.scope || "USER",
			isExternal: input.framework === "A2A",
		});

		// For A2A framework, deploymentUrl is required
		if (input.framework === "A2A" && !input.deploymentUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Deployment URL is required for A2A agents",
			});
		}

		// For MCP framework, deploymentUrl is required
		if (input.framework === "MCP" && !input.deploymentUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Deployment URL is required for MCP agents",
			});
		}

		// MANDATORY: Full A2A protocol validation for A2A agents
		// Validates: Agent Card + /health + /a2a/send
		if (input.framework === "A2A" && input.deploymentUrl) {
			console.log(
				"[createRegisteredAgent] Validating A2A protocol (mandatory):",
				{
					deploymentUrl: input.deploymentUrl,
				},
			);

			try {
				const validationResult = await validateA2AEndpoint(
					input.deploymentUrl,
					{
						testSendMessage: true, // Full validation includes send test
						timeout: 10000,
					},
				);

				if (!validationResult.valid) {
					const errorMessages =
						validationResult.errors.length > 0
							? validationResult.errors.join(", ")
							: "Agent failed A2A protocol validation";
					throw new ORPCError("BAD_REQUEST", {
						message: `A2A validation failed: ${errorMessages}`,
					});
				}

				// Validate required capabilities
				if (!validationResult.capabilities.agentCard) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Agent Card not found at /.well-known/agent.json",
					});
				}

				if (!validationResult.capabilities.sendMessage) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Agent does not respond to POST /a2a/send endpoint",
					});
				}

				console.log(
					"[createRegisteredAgent] A2A protocol validation passed:",
					{
						name: validationResult.agentCard?.name,
						protocolVersion: validationResult.protocolVersion,
						capabilities: validationResult.capabilities,
					},
				);

				// Auto-populate metadata from Agent Card if not provided
				if (validationResult.agentCard && !input.config) {
					const extracted = extractAgentMetadata(
						validationResult.agentCard,
					);
					input.config = {
						capabilities: extracted.capabilities,
						skills: extracted.skills,
						supportsStreaming: extracted.supportsStreaming,
						protocolVersion: validationResult.protocolVersion,
					};
				}
			} catch (error) {
				if (error instanceof ORPCError) {
					throw error;
				}
				console.error(
					"[createRegisteredAgent] A2A validation failed:",
					error,
				);
				throw new ORPCError("BAD_REQUEST", {
					message: `A2A validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}
		}

		// Optional: Validate AG-UI protocol support for non-A2A external agents
		if (
			input.validateProtocol &&
			input.deploymentUrl &&
			input.framework !== "A2A" &&
			input.framework !== "MCP"
		) {
			console.log("[createRegisteredAgent] Validating AG-UI protocol:", {
				deploymentUrl: input.deploymentUrl,
			});

			try {
				const metadataUrl = `${input.deploymentUrl}/metadata`;
				const response = await fetch(metadataUrl, {
					method: "GET",
					headers: { "Content-Type": "application/json" },
					signal: AbortSignal.timeout(5000),
				});

				if (!response.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message: `Failed to fetch agent metadata: ${response.status} ${response.statusText}`,
					});
				}

				const rawMetadata = await response.json();
				const validationResult = safeValidateAgentMetadata(rawMetadata);

				if (!validationResult.success) {
					const errors = validationResult.error.issues.map(
						(err) =>
							`${String(err.path.join("."))}:  ${err.message}`,
					);
					throw new ORPCError("BAD_REQUEST", {
						message: `Invalid agent metadata: ${errors.join(", ")}`,
					});
				}

				const metadata = validationResult.data;

				if (!supportsAGUIProtocol(metadata)) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Agent does not support AG-UI protocol (supportsAGUIProtocol: false)",
					});
				}

				if (!hasRequiredEndpoints(metadata)) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Agent is missing required endpoints (/invoke, /stream, /health)",
					});
				}

				console.log(
					"[createRegisteredAgent] AG-UI protocol validation passed:",
					{
						name: metadata.name,
						framework: metadata.framework,
						agUIProtocolVersion: metadata.agUIProtocolVersion,
					},
				);
			} catch (error) {
				if (error instanceof ORPCError) {
					throw error;
				}
				console.error(
					"[createRegisteredAgent] Protocol validation failed:",
					error,
				);
				throw new ORPCError("BAD_REQUEST", {
					message: `Failed to validate AG-UI protocol: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}
		}

		try {
			// A2A, MCP, and COPILOTKIT external agents go to RegisteredAgent table
			if (
				input.framework === "A2A" ||
				input.framework === "MCP" ||
				input.framework === "COPILOTKIT"
			) {
				const agent = await createExternalAgent({
					agentId,
					name: input.name,
					displayName: input.displayName,
					description: input.description,
					framework: input.framework,
					deploymentUrl: input.deploymentUrl,
					userId,
					organizationId,
					scope: input.scope || "USER",
					config: input.config,
					metadata: {
						...input.metadata,
						createdVia: "ui",
						registeredAt: new Date().toISOString(),
						frameworkType:
							input.framework === "MCP"
								? "tool-provider"
								: "task-executor",
					},
					status: "ACTIVE",
				});

				console.log(
					"[createRegisteredAgent] External agent created successfully:",
					{
						id: agent.id,
						agentId: agent.agentId,
						framework: agent.framework,
						deploymentUrl: agent.deploymentUrl,
					},
				);

				// Fire-and-forget immediate health check — never blocks the API response
				getTemporalClient()
					.then((client) =>
						client.workflow.start(
							"agentHealthMonitorWorkflow",
							withCorrelationMemo({
								taskQueue: "fabric-worker",
								workflowId: `agent-health-onboard-${agent.agentId}-${Date.now()}`,
								args: [{ targetAgentIds: [agent.agentId] }],
							}),
						),
					)
					.catch((err) => {
						// Non-fatal — health monitor will pick up within 2 minutes anyway
						console.warn(
							`[AgentRegistry] Failed to trigger immediate health check for ${agent.agentId}:`,
							err,
						);
					});

				return {
					...agent,
					userId: agent.userId,
					runtimeVersion: null,
					lastDeployedAt: null,
				};
			}

			// Internal agents (LangGraph, etc.) go to Agent table
			const agent = await createAgent({
				agentId,
				name: input.name,
				displayName: input.displayName,
				description: input.description,
				framework: input.framework as
					| "LANGGRAPH"
					| "PYDANTIC_AI"
					| "OPENAI"
					| "CREWAI"
					| "AUTOGEN"
					| "CUSTOM",
				// For LangGraph agents, set deploymentUrl to shared runtime URL
				deploymentUrl:
					input.framework === "LANGGRAPH"
						? langGraphRuntimeUrl
						: input.deploymentUrl || null,
				userId,
				organizationId,
				scope: input.scope as
					| "USER"
					| "ORGANIZATION"
					| "SYSTEM"
					| undefined,
				config: input.config,
				metadata: {
					...input.metadata,
					createdVia: "ui",
				},
				status: "ACTIVE",
			});

			console.log("[createRegisteredAgent] Agent created successfully:", {
				id: agent.id,
				agentId: agent.agentId,
				status: agent.status,
				agentUrl: langGraphRuntimeUrl
					? `${langGraphRuntimeUrl}/agents/${agentId}/chat`
					: null,
			});

			return agent;
		} catch (error) {
			console.error(
				"[createRegisteredAgent] Error creating agent:",
				error,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create agent",
			});
		}
	});
