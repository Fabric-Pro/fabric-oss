/**
 * Agent Endpoint Resolution
 *
 * Resolves agent IDs to their deployment endpoints.
 * Handles Docker container name resolution and environment overrides.
 */

import { db } from "@repo/database";
import { resolveAgentUrl } from "../../../lib/agent-url-resolver";
import type { ResolvedAgent } from "../types";

// Re-exported so existing consumers (orchestrator barrel, @repo/temporal/activities) keep working.
export { resolveAgentUrl };

export function isExternalAgentScope(scope: string): boolean {
	return scope !== "SYSTEM";
}

/**
 * Resolves exact agentId/name matches and case-insensitive SYSTEM
 * agentId/name/displayName matches to an A2A endpoint.
 * SYSTEM registrations shadow member registrations that name the same key,
 * including when the winning SYSTEM registration is unavailable.
 */
export async function resolveAgentEndpoint(
	agentId: string,
	userId: string,
	organizationId?: string,
): Promise<ResolvedAgent | null> {
	console.log(`[Orchestrator] Resolving agent endpoint: ${agentId}`);

	const registeredAgent = await resolveVisibleRegisteredAgent(
		agentId,
		userId,
		organizationId,
	);
	return endpointFromRegisteredAgent(registeredAgent, agentId);
}

/** Whether a registration names the trimmed key, ignoring case. */
export function registeredAgentNamesKey(
	agent: { agentId: string; name: string; displayName: string },
	key: string,
): boolean {
	const normalizedKey = key.trim().toLowerCase();
	return [agent.agentId, agent.name, agent.displayName].some(
		(value) => value.toLowerCase() === normalizedKey,
	);
}

type AgentEndpointRegistration = {
	status: string;
	deploymentUrl: string | null;
	metadata: unknown;
};

/** Availability shared by explicit routing and endpoint resolution. */
export function isRegisteredAgentEndpointAvailable(
	agent: AgentEndpointRegistration,
): agent is AgentEndpointRegistration & { deploymentUrl: string } {
	const metadata = agent.metadata as Record<string, unknown> | null;
	const protocols = metadata?.protocols;
	return (
		agent.status === "ACTIVE" &&
		Boolean(agent.deploymentUrl) &&
		Array.isArray(protocols) &&
		protocols.some(
			(protocol) =>
				typeof protocol === "string" &&
				protocol.toLowerCase() === "a2a",
		)
	);
}

/** Scope first, then caller-supplied match rank, oldest registration and id. */
export function compareRegisteredAgentPrecedence(
	a: { scope: string; createdAt: Date; id: string },
	b: { scope: string; createdAt: Date; id: string },
	aMatchRank: number,
	bMatchRank: number,
): number {
	const rank = (scope: string) =>
		scope === "SYSTEM" ? 0 : scope === "USER" ? 1 : 2;
	return (
		rank(a.scope) - rank(b.scope) ||
		aMatchRank - bMatchRank ||
		a.createdAt.getTime() - b.createdAt.getTime() ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

export async function resolveVisibleRegisteredAgent(
	agentId: string,
	userId: string,
	organizationId?: string,
) {
	const key = agentId.trim();
	const filters = {
		OR: [
			{ scope: "SYSTEM" },
			{ userId, scope: "USER" },
			...(organizationId
				? [{ organizationId, scope: "ORGANIZATION" }]
				: []),
		],
	};
	const candidates = await db.registeredAgent.findMany({
		where: {
			AND: [
				filters,
				{
					OR: [
						{ agentId: key },
						{ name: key },
						{
							scope: "SYSTEM",
							OR: [
								{
									agentId: {
										equals: key,
										mode: "insensitive",
									},
								},
								{ name: { equals: key, mode: "insensitive" } },
								{
									displayName: {
										equals: key,
										mode: "insensitive",
									},
								},
							],
						},
					],
				},
			],
		},
	});
	const hasNamingSystem = candidates.some(
		(agent) =>
			agent.scope === "SYSTEM" && registeredAgentNamesKey(agent, key),
	);
	const competing = candidates.filter((agent) =>
		hasNamingSystem
			? agent.scope === "SYSTEM" && registeredAgentNamesKey(agent, key)
			: agent.agentId === key || agent.name === key,
	);
	const matchRank = (agent: (typeof candidates)[number]) => {
		if (agent.agentId === key) {
			return 0;
		}
		if (agent.scope !== "SYSTEM" || agent.name === key) {
			return 1;
		}
		if (
			[agent.agentId, agent.name].some(
				(value) => value.toLowerCase() === key.toLowerCase(),
			)
		) {
			return 2;
		}
		return 3; // SYSTEM displayName match
	};
	const winner = competing.sort((a, b) =>
		compareRegisteredAgentPrecedence(a, b, matchRank(a), matchRank(b)),
	)[0];
	// Keep the winning snapshot for availability logging and capability fallback tags.
	return winner ?? null;
}

export function endpointFromRegisteredAgent(
	registeredAgent: Awaited<ReturnType<typeof resolveVisibleRegisteredAgent>>,
	agentId: string,
): ResolvedAgent | null {
	if (
		registeredAgent &&
		isRegisteredAgentEndpointAvailable(registeredAgent)
	) {
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

		// The shared availability check validated protocol support.
		const protocols = (metadata?.protocols as string[]) || [];

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
			isExternal: isExternalAgentScope(registeredAgent.scope),
		};
	}

	if (registeredAgent?.status === "ACTIVE" && registeredAgent.deploymentUrl) {
		console.warn(
			`[Orchestrator] Agent ${registeredAgent.name} does not support A2A protocol.`,
			{ scope: registeredAgent.scope, status: registeredAgent.status },
		);
	} else if (registeredAgent) {
		console.warn("[Orchestrator] Registered agent endpoint unavailable", {
			agentId: registeredAgent.agentId,
			scope: registeredAgent.scope,
			status: registeredAgent.status,
			hasDeploymentUrl: Boolean(registeredAgent.deploymentUrl),
		});
	} else {
		console.warn(`[Orchestrator] Agent not found: ${agentId}`);
		console.warn(
			`[Orchestrator] Run 'pnpm --filter @repo/database seed:system-agents' to register system agents`,
		);
	}
	return null;
}
