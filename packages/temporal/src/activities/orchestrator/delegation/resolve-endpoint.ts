/**
 * Agent Endpoint Resolution
 *
 * Resolves agent IDs to their deployment endpoints.
 * Handles Docker container name resolution and environment overrides.
 */

import { db, findAgentsByCapabilityTag } from "@repo/database";
import { resolveAgentUrl } from "../../../lib/agent-url-resolver";
import type { ResolvedAgent } from "../types";

// Re-exported so existing consumers (orchestrator barrel, @repo/temporal/activities) keep working.
export { resolveAgentUrl };

/**
 * Resolves an agent ID to its deployment endpoint.
 * All agents MUST support A2A protocol for the orchestrator to communicate with them.
 *
 * Resolution order:
 * 1. RegisteredAgent table (database) - PRIMARY source for all agents
 * 2. Fallback URLs (for backwards compatibility when DB is empty)
 *
 * To register agents, run: pnpm --filter @repo/database seed:system-agents
 */
export async function resolveAgentEndpoint(
	agentId: string,
	userId: string,
	organizationId?: string,
): Promise<ResolvedAgent | null> {
	console.log(`[Orchestrator] Resolving agent endpoint: ${agentId}`);

	// PRIMARY: Check RegisteredAgent table (includes system, org, and user agents)
	const registeredAgent = await db.registeredAgent.findFirst({
		where: {
			AND: [
				{
					OR: [{ agentId }, { name: agentId }],
				},
				{ status: "ACTIVE" },
				{
					OR: [
						{ scope: "SYSTEM" },
						{ userId, scope: "USER" },
						...(organizationId
							? [{ organizationId, scope: "ORGANIZATION" }]
							: []),
					],
				},
			],
		},
	});

	if (registeredAgent?.deploymentUrl) {
		// Warn if health check is stale (older than 5 minutes)
		const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
		if (
			registeredAgent.lastHealthCheck &&
			registeredAgent.lastHealthCheck < staleThreshold
		) {
			console.warn(
				`[Orchestrator] Agent ${registeredAgent.name} has a stale health check (last: ${registeredAgent.lastHealthCheck.toISOString()}). Health monitor may not have run yet.`,
			);
		}

		// Extract metadata
		const metadata = registeredAgent.metadata as Record<
			string,
			unknown
		> | null;

		// Check if agent supports A2A protocol from metadata.protocols
		// This is set during agent registration from the agent card
		const protocols = (metadata?.protocols as string[]) || [];
		const supportsA2A = protocols.some((p) => p.toLowerCase() === "a2a");

		// Agents MUST support A2A protocol for orchestrator communication
		// The protocol support must be declared in metadata.protocols (from agent card)
		if (!supportsA2A) {
			console.warn(
				`[Orchestrator] Agent ${registeredAgent.name} does not support A2A protocol. ` +
					`Protocols: [${protocols.join(", ")}]. ` +
					`Agents must have "A2A" in their protocols for orchestrator delegation. ` +
					`Run 'pnpm --filter @repo/database seed:system-agents' to update system agents.`,
			);
			// Return null to skip agents that don't support A2A
			return null;
		}

		// Resolve the actual runtime URL (handles Docker vs localhost)
		const resolvedUrl = resolveAgentUrl(
			registeredAgent.agentId,
			registeredAgent.deploymentUrl,
		);

		console.log(
			`[Orchestrator] Found agent in database: ${registeredAgent.displayName} ` +
				`(DB URL: ${registeredAgent.deploymentUrl}, Resolved: ${resolvedUrl}, ` +
				`Protocols: [${protocols.join(", ")}])`,
		);

		// Extract skills from metadata
		const skills =
			(metadata?.skills as Array<{
				id: string;
				name: string;
				description: string;
			}>) || [];

		return {
			agentId: registeredAgent.agentId,
			name: registeredAgent.displayName,
			deploymentUrl: resolvedUrl,
			protocol: "a2a",
			skills,
			supportsStreaming: true,
			isExternal: registeredAgent.scope !== "SYSTEM",
		};
	}

	// Agent not found in database
	console.warn(`[Orchestrator] Agent not found: ${agentId}`);
	console.warn(
		`[Orchestrator] Run 'pnpm --filter @repo/database seed:system-agents' to register system agents`,
	);
	return null;
}

/**
 * Resolve an agent's endpoint along with capability-matched fallback agents.
 *
 * Returns an ordered list of `ResolvedAgent` values: the primary agent first
 * (if found), followed by any fallback agents discovered dynamically from the
 * database by matching the primary agent's capability tags.
 *
 * This replaces the static `fallbackMap` in the recovery manager with a
 * database-driven lookup that automatically reflects newly registered agents.
 *
 * @param primaryAgentId - The agent ID of the preferred/primary agent
 * @param userId         - Required for tenant-scoped DB lookups
 * @param organizationId - Optional; when provided switches to org context
 * @returns Array of resolved agents, primary first. Empty if primary is not
 *          found and no capability-matched fallbacks exist.
 */
export async function resolveAgentEndpointWithFallbacks(
	primaryAgentId: string,
	userId: string,
	organizationId?: string,
): Promise<ResolvedAgent[]> {
	const results: ResolvedAgent[] = [];

	// 1. Resolve the primary agent
	const primary = await resolveAgentEndpoint(
		primaryAgentId,
		userId,
		organizationId,
	);

	// Collect the capability tags from the primary agent's DB record so we can
	// find agents with overlapping capabilities even when the primary is down.
	let capabilityTags: string[] = [];

	// Tenant-scoped condition — mirrors the XOR pattern used in resolveAgentEndpoint.
	const scopeConditions = [
		{ scope: "SYSTEM" as const },
		{ userId, scope: "USER" as const },
		...(organizationId
			? [{ organizationId, scope: "ORGANIZATION" as const }]
			: []),
	];

	if (primary) {
		results.push(primary);

		// Fetch the raw DB record to extract tags/skills from metadata
		const dbRecord = await db.registeredAgent.findFirst({
			where: {
				AND: [
					{
						OR: [
							{ agentId: primaryAgentId },
							{ name: primaryAgentId },
						],
					},
					{ status: "ACTIVE" },
					{ OR: scopeConditions },
				],
			},
			select: { metadata: true },
		});

		if (dbRecord?.metadata) {
			const meta = dbRecord.metadata as Record<string, unknown>;
			const metaTags = (meta.tags as string[] | undefined) ?? [];
			const skills =
				(meta.skills as Array<{ id: string }> | undefined) ?? [];
			capabilityTags = [...metaTags, ...skills.map((s) => s.id)];
		}
	} else {
		// Primary not found — attempt to discover any agent with a name/id
		// matching agentId so we can still pull capability tags for fallback.
		// We query without status restriction to recover tags even when STALE.
		const staleRecord = await db.registeredAgent.findFirst({
			where: {
				AND: [
					{
						OR: [
							{ agentId: primaryAgentId },
							{ name: primaryAgentId },
						],
					},
					{ OR: scopeConditions },
				],
			},
			select: { metadata: true },
		});

		if (staleRecord?.metadata) {
			const meta = staleRecord.metadata as Record<string, unknown>;
			const metaTags = (meta.tags as string[] | undefined) ?? [];
			const skills =
				(meta.skills as Array<{ id: string }> | undefined) ?? [];
			capabilityTags = [...metaTags, ...skills.map((s) => s.id)];
		}
	}

	// 2. Find fallback agents by capability tags (excludes the primary)
	if (capabilityTags.length > 0) {
		const fallbackAgents = await findAgentsByCapabilityTag({
			tags: capabilityTags,
			userId,
			organizationId,
			excludeAgentId: primaryAgentId,
		});

		for (const agent of fallbackAgents) {
			// Skip agents without a deployment URL (shouldn't happen after the
			// DB query but guard defensively)
			if (!agent.deploymentUrl) {
				continue;
			}

			const meta = agent.metadata as Record<string, unknown> | null;
			const skills =
				(meta?.skills as
					| Array<{ id: string; name: string; description: string }>
					| undefined) ?? [];

			const resolvedUrl = resolveAgentUrl(
				agent.agentId,
				agent.deploymentUrl,
			);

			results.push({
				agentId: agent.agentId,
				name: agent.displayName,
				deploymentUrl: resolvedUrl,
				protocol: "a2a",
				skills,
				supportsStreaming: true,
				isExternal: agent.scope !== "SYSTEM",
			});
		}
	}

	console.log(
		`[Orchestrator] resolveAgentEndpointWithFallbacks(${primaryAgentId}): ` +
			`found ${results.length} candidate(s) ` +
			`(primary=${primary ? "yes" : "no"}, fallbacks=${results.length - (primary ? 1 : 0)})`,
	);

	return results;
}
