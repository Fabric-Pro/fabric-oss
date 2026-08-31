/**
 * Discover Agent Endpoint
 *
 * Discovers an AG-UI-native agent by fetching its metadata from the deployment URL.
 * Validates AG-UI protocol support and returns agent configuration for registration.
 */

import {
	AgentMetadataResponseSchema,
	hasRequiredEndpoints,
	supportsAGUIProtocol,
} from "@repo/agent-core";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
} from "../../../../orpc/procedures";

/**
 * Discover an AG-UI-native agent
 *
 * This endpoint:
 * 1. Fetches agent metadata from deployment URL
 * 2. Validates AG-UI protocol support
 * 3. Checks for required endpoints (/invoke, /stream, /health)
 * 4. Returns agent configuration for registration
 *
 * @example
 * ```typescript
 * const result = await client.agents.registry.discover({
 *   deploymentUrl: "http://localhost:8000",
 *   apiKey: "optional-api-key"
 * });
 * ```
 */
export const discoverAgent = protectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/registry/discover",
		tags: ["Agent Registry"],
		summary: "Discover AG-UI-native agent",
		description:
			"Discover an agent by fetching metadata from its deployment URL and validating AG-UI protocol support",
	})
	.input(
		z.object({
			/** Deployment URL where the agent is running */
			deploymentUrl: z.string().url(),

			/** Optional API key for authentication */
			apiKey: z.string().optional(),

			/** Timeout in milliseconds (default: 5000ms) */
			timeout: z.number().positive().optional().default(5000),
		}),
	)
	.output(
		z.object({
			/** Agent metadata */
			metadata: AgentMetadataResponseSchema,

			/** Deployment URL */
			deploymentUrl: z.string().url(),

			/** Whether the agent is healthy */
			healthy: z.boolean(),

			/** Response time in milliseconds */
			responseTime: z.number(),

			/** Discovery timestamp */
			discoveredAt: z.date(),

			/** Validation results */
			validation: z.object({
				supportsAGUIProtocol: z.boolean(),
				hasRequiredEndpoints: z.boolean(),
				errors: z.array(z.string()),
			}),
		}),
	)
	.handler(async ({ input, context }) => {
		const { deploymentUrl, apiKey, timeout } = input;
		const startTime = Date.now();

		console.log("[discoverAgent] Discovering agent:", {
			deploymentUrl,
			userId: context.user.id,
		});

		try {
			// Fetch agent metadata
			const metadataUrl = `${deploymentUrl}/metadata`;
			const response = await fetch(metadataUrl, {
				method: "GET",
				headers: {
					"Content-Type": "application/json",
					...(apiKey && { Authorization: `Bearer ${apiKey}` }),
				},
				signal: AbortSignal.timeout(timeout),
			});

			if (!response.ok) {
				throw new Error(
					`Failed to fetch metadata: ${response.status} ${response.statusText}`,
				);
			}

			const rawMetadata = await response.json();
			const responseTime = Date.now() - startTime;

			// Validate metadata
			const validationResult =
				AgentMetadataResponseSchema.safeParse(rawMetadata);

			if (!validationResult.success) {
				const errors = validationResult.error.issues.map(
					(err) => `${String(err.path.join("."))}:  ${err.message}`,
				);

				console.error("[discoverAgent] Metadata validation failed:", {
					deploymentUrl,
					errors,
				});

				throw new Error(`Invalid agent metadata: ${errors.join(", ")}`);
			}

			const metadata = validationResult.data;

			// Validate AG-UI protocol support
			const validation = {
				supportsAGUIProtocol: supportsAGUIProtocol(metadata),
				hasRequiredEndpoints: hasRequiredEndpoints(metadata),
				errors: [] as string[],
			};

			if (!validation.supportsAGUIProtocol) {
				validation.errors.push(
					"Agent does not support AG-UI protocol (supportsAGUIProtocol: false)",
				);
			}

			if (!validation.hasRequiredEndpoints) {
				validation.errors.push(
					"Agent is missing required endpoints (/invoke, /stream, /health)",
				);
			}

			// Check health endpoint
			let healthy = false;
			try {
				const healthResponse = await fetch(
					`${deploymentUrl}${metadata.endpoints.health}`,
					{
						method: "GET",
						headers: apiKey
							? { Authorization: `Bearer ${apiKey}` }
							: {},
						signal: AbortSignal.timeout(timeout),
					},
				);
				healthy = healthResponse.ok;
			} catch (error) {
				console.warn("[discoverAgent] Health check failed:", error);
				validation.errors.push(
					`Health check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			}

			console.log("[discoverAgent] Agent discovered successfully:", {
				name: metadata.name,
				framework: metadata.framework,
				language: metadata.language,
				healthy,
				responseTime,
			});

			return {
				metadata,
				deploymentUrl,
				healthy,
				responseTime,
				discoveredAt: new Date(),
				validation,
			};
		} catch (error) {
			const responseTime = Date.now() - startTime;

			console.error("[discoverAgent] Discovery failed:", {
				deploymentUrl,
				error: error instanceof Error ? error.message : "Unknown error",
				responseTime,
			});

			throw new Error(
				`Failed to discover agent: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	});
