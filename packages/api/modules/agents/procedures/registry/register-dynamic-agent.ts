/**
 * Dynamic Agent Registration Procedure
 *
 * Registers agents at runtime without requiring server restart.
 * Supports A2A, MCP, and internal agent protocols.
 *
 * Features:
 * - Hot registration without deployment
 * - Protocol validation (A2A, AG-UI)
 * - Health check integration
 * - Capability extraction from agent cards
 * - Event emission for capability discovery
 */

import { ORPCError } from "@orpc/server";
import { createId } from "@paralleldrive/cuid2";
import { extractAgentMetadata, validateA2AEndpoint } from "@repo/agent-core";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";

// =============================================================================
// Input Schema
// =============================================================================

const DynamicAgentInputSchema = z.object({
	/** Unique identifier for the agent (auto-generated if not provided) */
	agentId: z.string().optional(),
	/** Human-readable name */
	name: z.string().min(1).max(100),
	/** Display name shown in UI */
	displayName: z.string().min(1).max(200),
	/** Agent description */
	description: z.string().optional(),
	/** Protocol type */
	protocol: z.enum(["A2A", "MCP", "AG_UI", "CUSTOM"]),
	/** Deployment URL (required for external agents) */
	deploymentUrl: z.string().url(),
	/** Agent scope */
	scope: z.enum(["USER", "ORGANIZATION", "SYSTEM"]).default("USER"),
	/** Organization ID (for ORGANIZATION scope) */
	organizationId: z.string().nullable().optional(),
	/** Agent capabilities (auto-extracted if not provided) */
	capabilities: z
		.object({
			skills: z.array(z.string()).optional(),
			inputTypes: z.array(z.string()).optional(),
			outputTypes: z.array(z.string()).optional(),
			supportsStreaming: z.boolean().optional(),
			maxConcurrency: z.number().optional(),
			timeoutMs: z.number().optional(),
		})
		.optional(),
	/** Custom metadata */
	metadata: z.record(z.string(), z.unknown()).optional(),
	/** Skip protocol validation (not recommended) */
	skipValidation: z.boolean().default(false),
	/** Tags for categorization */
	tags: z.array(z.string()).optional(),
});

// =============================================================================
// Output Schema
// =============================================================================

const DynamicAgentOutputSchema = z.object({
	id: z.string(),
	agentId: z.string(),
	name: z.string(),
	displayName: z.string(),
	description: z.string().nullable(),
	protocol: z.string(),
	deploymentUrl: z.string().nullable(),
	status: z.enum(["ACTIVE", "INACTIVE", "PENDING", "ERROR"]),
	scope: z.string(),
	capabilities: z.record(z.string(), z.unknown()).nullable(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
	healthStatus: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
	registeredAt: z.date(),
	lastHealthCheck: z.date().nullable(),
});

// =============================================================================
// Procedure
// =============================================================================

export const registerDynamicAgent = protectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_CREATE))
	.route({
		method: "POST",
		path: "/agents/registry/dynamic",
		tags: ["Agent Registry", "Dynamic Registration"],
		summary: "Register agent dynamically",
		description:
			"Register a new agent at runtime without server restart. Supports A2A, MCP, and custom protocols.",
	})
	.input(DynamicAgentInputSchema)
	.output(DynamicAgentOutputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// SECURITY (SOC 2 CC6.1/CC6.3): SYSTEM-scoped agents are global (every
		// tenant) with an attacker-controlled deploymentUrl. Restrict SYSTEM
		// registration to platform admins. requireInputOrgPermission verifies
		// org membership for ORGANIZATION scope; SYSTEM has no org.
		if (input.scope === "SYSTEM" && context.user.role !== "admin") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only platform admins can register SYSTEM-scoped agents",
			});
		}

		const startTime = Date.now();

		console.log("[registerDynamicAgent] Starting registration", {
			name: input.name,
			protocol: input.protocol,
			deploymentUrl: input.deploymentUrl,
		});

		// Generate agent ID if not provided
		const agentId =
			input.agentId ||
			`dynamic-${input.protocol.toLowerCase()}-${input.name.toLowerCase().replace(/\s+/g, "-")}-${createId().slice(0, 8)}`;

		// Check for duplicate
		const existing = await db.registeredAgent.findFirst({
			where: {
				OR: [{ agentId }, { deploymentUrl: input.deploymentUrl }],
			},
		});

		if (existing) {
			throw new ORPCError("CONFLICT", {
				message:
					existing.agentId === agentId
						? `Agent with ID '${agentId}' already exists`
						: "Agent with deployment URL already registered",
			});
		}

		// Validate protocol and extract capabilities
		let healthStatus: "healthy" | "degraded" | "unhealthy" | "unknown" =
			"unknown";
		let extractedCapabilities = input.capabilities || {};
		let protocolVersion: string | undefined;

		if (!input.skipValidation) {
			try {
				if (input.protocol === "A2A") {
					const validation = await validateA2AEndpoint(
						input.deploymentUrl,
						{
							testSendMessage: false, // Don't test send for registration
							timeout: 10000,
						},
					);

					if (!validation.valid) {
						throw new ORPCError("BAD_REQUEST", {
							message: `A2A validation failed: ${validation.errors.join(", ")}`,
						});
					}

					healthStatus = "healthy";
					protocolVersion = validation.protocolVersion;

					// Extract capabilities from agent card
					if (validation.agentCard) {
						const extracted = extractAgentMetadata(
							validation.agentCard,
						);
						extractedCapabilities = {
							...extractedCapabilities,
							// Convert skill objects to skill names for consistency
							skills: extracted.skills.map((s) => s.name),
							supportsStreaming: extracted.supportsStreaming,
						};
					}

					console.log(
						"[registerDynamicAgent] A2A validation passed",
						{
							protocolVersion,
							capabilities: Object.keys(extractedCapabilities),
						},
					);
				} else if (input.protocol === "AG_UI") {
					// Validate AG-UI protocol
					const metadataUrl = `${input.deploymentUrl}/metadata`;
					const response = await fetch(metadataUrl, {
						method: "GET",
						headers: { "Content-Type": "application/json" },
						signal: AbortSignal.timeout(5000),
					});

					if (!response.ok) {
						throw new ORPCError("BAD_REQUEST", {
							message: `AG-UI metadata endpoint returned ${response.status}`,
						});
					}

					const metadata = await response.json();
					healthStatus = "healthy";

					if (metadata.capabilities) {
						extractedCapabilities = {
							...extractedCapabilities,
							...metadata.capabilities,
						};
					}

					console.log(
						"[registerDynamicAgent] AG-UI validation passed",
					);
				} else if (input.protocol === "MCP") {
					// For MCP, just check if the endpoint is reachable
					const response = await fetch(input.deploymentUrl, {
						method: "HEAD",
						signal: AbortSignal.timeout(5000),
					}).catch(() => null);

					healthStatus = response?.ok ? "healthy" : "degraded";
				} else {
					// Custom protocol - basic health check
					const healthUrl = `${input.deploymentUrl}/health`;
					const response = await fetch(healthUrl, {
						method: "GET",
						signal: AbortSignal.timeout(5000),
					}).catch(() => null);

					healthStatus = response?.ok ? "healthy" : "unknown";
				}
			} catch (error) {
				if (error instanceof ORPCError) {
					throw error;
				}

				console.error(
					"[registerDynamicAgent] Validation failed",
					error,
				);
				throw new ORPCError("BAD_REQUEST", {
					message: `Protocol validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}
		}

		// Create the agent record
		try {
			const agent = await db.registeredAgent.create({
				data: {
					agentId,
					name: input.name,
					displayName: input.displayName,
					description: input.description,
					framework: input.protocol,
					deploymentUrl: input.deploymentUrl,
					scope: input.scope,
					userId,
					organizationId,
					status: healthStatus === "healthy" ? "ACTIVE" : "PENDING",
					config: extractedCapabilities,
					metadata: {
						...input.metadata,
						registrationType: "dynamic",
						protocolVersion,
						tags: input.tags,
						registeredAt: new Date().toISOString(),
						registrationDurationMs: Date.now() - startTime,
					},
					lastHealthCheck: new Date(),
				},
			});

			console.log(
				"[registerDynamicAgent] Agent registered successfully",
				{
					id: agent.id,
					agentId: agent.agentId,
					status: agent.status,
					healthStatus,
					durationMs: Date.now() - startTime,
				},
			);

			return {
				id: agent.id,
				agentId: agent.agentId,
				name: agent.name,
				displayName: agent.displayName,
				description: agent.description,
				protocol: agent.framework,
				deploymentUrl: agent.deploymentUrl,
				status: agent.status as
					| "ACTIVE"
					| "INACTIVE"
					| "PENDING"
					| "ERROR",
				scope: agent.scope,
				capabilities: agent.config as Record<string, unknown> | null,
				metadata: agent.metadata as Record<string, unknown> | null,
				healthStatus,
				registeredAt: agent.createdAt,
				lastHealthCheck: agent.lastHealthCheck,
			};
		} catch (error) {
			console.error("[registerDynamicAgent] Database error", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create agent record",
			});
		}
	});

// =============================================================================
// Bulk Registration
// =============================================================================

// Bulk registration is implemented inline to avoid circular handler reference issues

// =============================================================================
// Refresh Agent
// =============================================================================

export const refreshDynamicAgent = protectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_CREATE))
	.route({
		method: "POST",
		path: "/agents/registry/dynamic/refresh",
		tags: ["Agent Registry", "Dynamic Registration"],
		summary: "Refresh agent capabilities",
		description: "Re-fetch agent capabilities and update health status.",
	})
	.input(
		z.object({
			agentId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(DynamicAgentOutputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const orConditions: Array<Record<string, unknown>> = [
			{ userId: context.user.id },
			{ scope: "SYSTEM" },
		];
		if (organizationId) {
			orConditions.push({ organizationId });
		}

		const agent = await db.registeredAgent.findFirst({
			where: {
				agentId: input.agentId,
				OR: orConditions,
			},
		});

		if (!agent) {
			throw new ORPCError("NOT_FOUND", {
				message: `Agent '${input.agentId}' not found`,
			});
		}

		// Re-validate and extract capabilities
		let healthStatus: "healthy" | "degraded" | "unhealthy" | "unknown" =
			"unknown";
		let updatedCapabilities =
			(agent.config as Record<string, unknown>) || {};

		if (!agent.deploymentUrl) {
			healthStatus = "unknown";
		} else {
			try {
				if (agent.framework === "A2A") {
					const validation = await validateA2AEndpoint(
						agent.deploymentUrl,
						{
							testSendMessage: false,
							timeout: 10000,
						},
					);

					healthStatus = validation.valid ? "healthy" : "unhealthy";

					if (validation.agentCard) {
						const extracted = extractAgentMetadata(
							validation.agentCard,
						);
						updatedCapabilities = {
							...updatedCapabilities,
							skills: extracted.skills,
							supportsStreaming: extracted.supportsStreaming,
							...extracted.capabilities,
						};
					}
				} else {
					// Generic health check
					const healthUrl = `${agent.deploymentUrl}/health`;
					const response = await fetch(healthUrl, {
						method: "GET",
						signal: AbortSignal.timeout(5000),
					}).catch(() => null);

					healthStatus = response?.ok ? "healthy" : "degraded";
				}
			} catch {
				healthStatus = "unhealthy";
			}
		}

		// Update the agent
		const updated = await db.registeredAgent.update({
			where: { id: agent.id },
			data: {
				config: updatedCapabilities as unknown as Parameters<
					typeof db.registeredAgent.update
				>[0]["data"]["config"],
				status:
					healthStatus === "healthy"
						? "ACTIVE"
						: healthStatus === "unhealthy"
							? "ERROR"
							: "PENDING",
				lastHealthCheck: new Date(),
				metadata: {
					...((agent.metadata as Record<string, unknown>) || {}),
					lastRefreshedAt: new Date().toISOString(),
				} as unknown as Parameters<
					typeof db.registeredAgent.update
				>[0]["data"]["metadata"],
			},
		});

		return {
			id: updated.id,
			agentId: updated.agentId,
			name: updated.name,
			displayName: updated.displayName,
			description: updated.description,
			protocol: updated.framework,
			deploymentUrl: updated.deploymentUrl,
			status: updated.status as
				| "ACTIVE"
				| "INACTIVE"
				| "PENDING"
				| "ERROR",
			scope: updated.scope,
			capabilities: updated.config as Record<string, unknown> | null,
			metadata: updated.metadata as Record<string, unknown> | null,
			healthStatus,
			registeredAt: updated.createdAt,
			lastHealthCheck: updated.lastHealthCheck,
		};
	});
