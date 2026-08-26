import {
	db,
	getAgentsByIds,
	getAgentsNeedingHealthCheck,
} from "@repo/database";
import { isProbeableAgent } from "../../lib/agent-probeable";

export interface GetAgentsNeedingHealthCheckInput {
	maxAgeMinutes: number;
	/** If provided, fetch only these specific agents (by agentId) regardless of health check staleness */
	targetAgentIds?: string[];
}

export interface AgentHealthCheckTarget {
	agentId: string;
	deploymentUrl: string;
	name: string;
	/** Owner userId — used for embedding model resolution */
	userId?: string;
	/** Owner organizationId — used for embedding model resolution */
	organizationId?: string;
	/** Pre-built search text for embedding (name + description + skills + tags) */
	agentSearchText?: string;
}

/**
 * Build the canonical search text for an agent — must match the text used in
 * search-agents.ts so that the stored embedding aligns with search queries.
 */
function buildAgentSearchText(agent: {
	displayName: string;
	description?: string | null;
	metadata?: unknown;
}): string {
	const metadata = agent.metadata as Record<string, unknown> | null;
	const skills =
		(metadata?.skills as Array<{ name: string; description?: string }>) ||
		[];
	const tags = (metadata?.tags as string[]) || [];
	return `${agent.displayName}: ${agent.description || ""}. Skills: ${skills.map((s) => s.name).join(", ")}. Tags: ${tags.join(", ")}`;
}

/**
 * Cache for the fallback userId used when resolving embedding models for
 * SYSTEM scope agents (which have no owner userId).
 *
 * Populated once per worker process — first from SYSTEM_EMBEDDING_USER_ID env
 * var, then by querying the database for the configured seed user email.
 */
let cachedFallbackUserId: string | undefined | null; // undefined = not yet resolved, null = not found

async function resolveFallbackUserId(): Promise<string | undefined> {
	if (cachedFallbackUserId !== undefined) {
		// Already resolved (even if null)
		return cachedFallbackUserId ?? undefined;
	}

	// Prefer explicit env var override
	const envUserId = process.env.SYSTEM_EMBEDDING_USER_ID;
	if (envUserId) {
		cachedFallbackUserId = envUserId;
		return cachedFallbackUserId;
	}

	// Fall back to seed user email lookup. SEED_USER_EMAIL accepts a single
	// email or a comma-separated priority list (try each, return the first
	// matching user). Useful when the primary fallback account may be removed
	// and a backup admin should take over the SYSTEM-agent embedding role.
	const seedEmailRaw = process.env.SEED_USER_EMAIL;
	if (!seedEmailRaw) {
		cachedFallbackUserId = null;
		return undefined;
	}
	const seedEmails = seedEmailRaw
		.split(/[,;]/)
		.map((e) => e.trim())
		.filter(Boolean);
	if (seedEmails.length === 0) {
		cachedFallbackUserId = null;
		return undefined;
	}
	try {
		const user = await db.user.findFirst({
			where: { email: { in: seedEmails } },
			select: { id: true },
		});
		cachedFallbackUserId = user?.id ?? null;
	} catch {
		cachedFallbackUserId = null;
	}

	return cachedFallbackUserId ?? undefined;
}

export async function getAgentsNeedingHealthCheckActivity(
	input: GetAgentsNeedingHealthCheckInput,
): Promise<AgentHealthCheckTarget[]> {
	const agents =
		input.targetAgentIds && input.targetAgentIds.length > 0
			? await getAgentsByIds(input.targetAgentIds)
			: await getAgentsNeedingHealthCheck(input.maxAgeMinutes);

	// Only probe agents that expose an external HTTP /health endpoint. In-process
	// FABRIC_NATIVE agents and inline agents with no deployment URL have nothing
	// to probe — probing them only ever produces a false ERROR. See #1685.
	const filtered = agents.filter(isProbeableAgent);

	// Resolve fallback userId once for all SYSTEM agents in this batch
	const hasSystemAgent = filtered.some((a) => a.userId === null);
	const fallbackUserId = hasSystemAgent
		? await resolveFallbackUserId()
		: undefined;

	return filtered.map((a) => {
		// For SYSTEM scope agents (userId is null), use the fallback userId so
		// that embedding model resolution can succeed.
		const effectiveUserId =
			a.userId !== null ? a.userId : (fallbackUserId ?? undefined);

		return {
			agentId: a.agentId,
			deploymentUrl: a.deploymentUrl,
			name: a.name,
			userId: effectiveUserId,
			organizationId: a.organizationId ?? undefined,
			agentSearchText: buildAgentSearchText(a),
		};
	});
}
