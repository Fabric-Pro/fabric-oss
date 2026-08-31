/**
 * Discover A2A Agent Endpoint
 *
 * Discovers an A2A-protocol agent by fetching its Agent Card from the deployment URL.
 * Validates A2A protocol support and returns agent configuration for registration.
 */

import { extractAgentMetadata, validateA2AEndpoint } from "@repo/agent-core";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
} from "../../../../orpc/procedures";

/**
 * A2A Agent Skill Schema
 */
const A2ASkillSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
});

/**
 * A2A Capabilities Schema
 */
const A2ACapabilitiesSchema = z.object({
	streaming: z.boolean().optional(),
	pushNotifications: z.boolean().optional(),
	stateTransitionHistory: z.boolean().optional(),
});

/**
 * A2A Agent Card Schema (for output)
 */
const A2AAgentCardSchema = z.object({
	name: z.string(),
	description: z.string(),
	url: z.string(),
	protocolVersion: z.string(),
	capabilities: A2ACapabilitiesSchema.optional(),
	skills: z.array(A2ASkillSchema),
});

/**
 * Discover an A2A-protocol agent
 *
 * This endpoint:
 * 1. Fetches Agent Card from /.well-known/agent.json
 * 2. Validates A2A protocol support
 * 3. Extracts agent metadata for registration
 * 4. Returns agent configuration
 *
 * @example
 * ```typescript
 * const result = await client.agents.registry.discoverA2A({
 *   deploymentUrl: "http://localhost:8000",
 * });
 * ```
 */
export const discoverA2AAgent = protectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/registry/discover-a2a",
		tags: ["Agent Registry"],
		summary: "Discover A2A-protocol agent",
		description:
			"Discover an agent by fetching its Agent Card and validating A2A protocol support",
	})
	.input(
		z.object({
			/** Deployment URL where the agent is running */
			deploymentUrl: z.string().url(),

			/** Timeout in milliseconds (default: 10000ms) */
			timeout: z.number().positive().optional().default(10000),

			/** Whether to test the /a2a/send endpoint (slower but more thorough) */
			testSendMessage: z.boolean().optional().default(false),
		}),
	)
	.output(
		z.object({
			/** Whether the agent is valid and can be registered */
			valid: z.boolean(),

			/** Agent Card from the agent */
			agentCard: A2AAgentCardSchema.nullable(),

			/** Protocol version */
			protocolVersion: z.string().nullable(),

			/** Deployment URL */
			deploymentUrl: z.string().url(),

			/** Whether the agent is healthy */
			healthy: z.boolean(),

			/** Response time in milliseconds */
			responseTime: z.number(),

			/** Discovery timestamp */
			discoveredAt: z.date(),

			/** Extracted metadata for registration */
			registrationData: z
				.object({
					name: z.string(),
					displayName: z.string(),
					description: z.string(),
					capabilities: z.array(z.string()),
					skills: z.array(A2ASkillSchema),
					supportsStreaming: z.boolean(),
				})
				.nullable(),

			/** Validation results */
			validation: z.object({
				agentCard: z.boolean(),
				sendMessage: z.boolean(),
				streaming: z.boolean(),
				taskManagement: z.boolean(),
				errors: z.array(z.string()),
			}),

			/** Whether the /health endpoint returned 2xx */
			healthEndpointAvailable: z.boolean(),

			/** Warning about missing /health endpoint (non-fatal) */
			healthWarning: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { deploymentUrl, timeout, testSendMessage } = input;
		const startTime = Date.now();

		console.log("[discoverA2AAgent] Discovering A2A agent:", {
			deploymentUrl,
			userId: context.user.id,
		});

		try {
			// Validate A2A protocol
			const validationResult = await validateA2AEndpoint(deploymentUrl, {
				testSendMessage,
				timeout,
			});

			const responseTime = Date.now() - startTime;

			// Extract registration data if valid
			let registrationData = null;
			if (validationResult.valid && validationResult.agentCard) {
				const extracted = extractAgentMetadata(
					validationResult.agentCard,
				);
				registrationData = {
					name: extracted.name,
					displayName: extracted.displayName,
					description: extracted.description,
					capabilities: extracted.capabilities,
					skills: extracted.skills,
					supportsStreaming: extracted.supportsStreaming,
				};
			}

			// Check /health endpoint — required for health monitoring and embedding generation
			let healthEndpointAvailable = false;
			let healthWarning: string | undefined;
			try {
				const healthRes = await fetch(`${deploymentUrl}/health`, {
					signal: AbortSignal.timeout(3000),
				});
				healthEndpointAvailable = healthRes.ok;
				if (!healthRes.ok) {
					healthWarning = `/health returned ${healthRes.status}. The agent health monitor requires a /health endpoint returning 2xx. Without it, the agent will be marked ERROR and excluded from semantic search.`;
				}
			} catch {
				healthWarning = `No /health endpoint found at ${deploymentUrl}/health. The agent health monitor requires a /health endpoint returning 2xx. Without it, the agent will be marked ERROR and excluded from semantic search.`;
			}

			console.log("[discoverA2AAgent] Agent discovered:", {
				valid: validationResult.valid,
				name: validationResult.agentCard?.name,
				protocolVersion: validationResult.protocolVersion,
				responseTime,
				errors: validationResult.errors,
				healthEndpointAvailable,
			});

			return {
				valid: validationResult.valid,
				agentCard: validationResult.agentCard || null,
				protocolVersion: validationResult.protocolVersion || null,
				deploymentUrl,
				healthy: validationResult.capabilities.agentCard,
				responseTime,
				discoveredAt: new Date(),
				registrationData,
				validation: {
					agentCard: validationResult.capabilities.agentCard,
					sendMessage: validationResult.capabilities.sendMessage,
					streaming: validationResult.capabilities.streaming,
					taskManagement:
						validationResult.capabilities.taskManagement,
					errors: validationResult.errors,
				},
				healthEndpointAvailable,
				healthWarning,
			};
		} catch (error) {
			const responseTime = Date.now() - startTime;

			console.error("[discoverA2AAgent] Discovery failed:", {
				deploymentUrl,
				error: error instanceof Error ? error.message : "Unknown error",
				responseTime,
			});

			return {
				valid: false,
				agentCard: null,
				protocolVersion: null,
				deploymentUrl,
				healthy: false,
				responseTime,
				discoveredAt: new Date(),
				registrationData: null,
				validation: {
					agentCard: false,
					sendMessage: false,
					streaming: false,
					taskManagement: false,
					errors: [
						error instanceof Error
							? error.message
							: "Unknown error",
					],
				},
				healthEndpointAvailable: false,
			};
		}
	});
