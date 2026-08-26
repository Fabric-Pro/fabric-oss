/**
 * Health Check Agent Procedure
 *
 * Performs a health check on a registered agent and updates the lastHealthCheck timestamp.
 * Supports SYSTEM, ORGANIZATION, and USER scoped agents.
 */

import { ORPCError } from "@orpc/server";
import {
	getRegisteredAgentById,
	updateRegisteredAgentHealthCheck,
} from "@repo/database";
import { isProbeableAgent, resolveAgentUrl } from "@repo/temporal/activities";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Health check a registered agent
 */
export const healthCheckAgent = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "POST",
		path: "/agents/registry/:id/health",
		tags: ["Agent Registry"],
		summary: "Health check agent",
		description: "Perform a health check on a registered agent",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			id: z.string(),
			agentId: z.string(),
			healthy: z.boolean(),
			lastHealthCheck: z.date(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { id } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Get agent from RegisteredAgent table
		const agent = await getRegisteredAgentById(id);

		if (!agent) {
			throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
		}

		// Check authorization based on scope
		switch (agent.scope) {
			case "SYSTEM":
				// System agents can be health-checked by any authenticated user
				break;

			case "ORGANIZATION": {
				// Organization-scoped agents require membership
				if (!agent.organizationId) {
					throw new ORPCError("FORBIDDEN", {
						message: "Invalid organization agent configuration",
					});
				}

				// Verify user is a member of the agent's organization
				const membership = await verifyOrganizationMembership(
					agent.organizationId,
					user.id,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You do not have access to this agent",
					});
				}

				// If caller specified an organizationId, it must match the agent's org
				if (organizationId && organizationId !== agent.organizationId) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Agent does not belong to the specified organization",
					});
				}
				break;
			}

			case "USER":
				// User-scoped agents can only be health-checked by owner
				if (agent.userId !== user.id) {
					throw new ORPCError("FORBIDDEN", {
						message: "You do not have access to this agent",
					});
				}

				// User agents in personal context should not be accessible from org context
				if (organizationId && !agent.organizationId) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Personal agent not accessible in organization context",
					});
				}
				break;

			default:
				throw new ORPCError("FORBIDDEN", {
					message: "Invalid agent scope",
				});
		}

		// Perform health check by making a request to the agent's deployment URL
		let healthy = false;
		let error: string | undefined;

		if (!isProbeableAgent(agent)) {
			// In-process FABRIC_NATIVE agents and inline agents (no deployment URL)
			// have no external /health endpoint — probing them only yields a false
			// ERROR. Treat them as healthy so they keep a clean status. See #1685.
			healthy = true;
		} else {
			const resolvedUrl = resolveAgentUrl(
				agent.agentId,
				agent.deploymentUrl,
			);
			try {
				const response = await fetch(`${resolvedUrl}/health`, {
					method: "GET",
					headers: { "Content-Type": "application/json" },
					signal: AbortSignal.timeout(5000),
				});
				healthy = response.ok;
				if (!healthy) {
					error = `Health check failed with status ${response.status} (probed ${resolvedUrl}/health)`;
				}
			} catch (err) {
				healthy = false;
				error =
					(err instanceof Error
						? err.message
						: "Health check failed") +
					` (probed ${resolvedUrl}/health)`;
			}
		}

		// Update lastHealthCheck + status in database (threshold-aware)
		const updatedAgent = await updateRegisteredAgentHealthCheck(
			agent.agentId,
			healthy,
			error,
		);

		return {
			id: updatedAgent.id,
			agentId: updatedAgent.agentId,
			healthy,
			lastHealthCheck: updatedAgent.lastHealthCheck ?? new Date(),
			error,
		};
	});
