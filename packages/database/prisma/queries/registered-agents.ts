/**
 * Database queries for Registered External Agents
 *
 * This module handles dynamically registered external agents (A2A protocol, etc.)
 * These are separate from the internal Agent model which is for LangGraph agents.
 */

import { db } from "../client";
import type { Prisma, RegisteredAgent } from "../generated/client";

/**
 * List registered agents for a tenant with XOR isolation.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT: SYSTEM + ORGANIZATION agents only
 * - PERSONAL CONTEXT: SYSTEM + USER agents only
 *
 * Personal agents are NEVER accessible in org context and vice versa.
 */
export async function listRegisteredAgents({
	userId,
	organizationId,
	framework,
	status,
	scope,
	limit = 50,
	offset = 0,
}: {
	userId: string;
	organizationId?: string;
	framework?: string;
	status?: string;
	scope?: string;
	limit?: number;
	offset?: number;
}): Promise<RegisteredAgent[]> {
	// XOR PATTERN: Strict context isolation
	const scopeConditions: Prisma.RegisteredAgentWhereInput[] = [
		{ scope: "SYSTEM" },
	];

	if (organizationId) {
		// ORGANIZATION CONTEXT: SYSTEM + ORG agents only (no personal agents)
		scopeConditions.push({ scope: "ORGANIZATION", organizationId });
	} else {
		// PERSONAL CONTEXT: SYSTEM + USER agents only (no org agents)
		scopeConditions.push({ scope: "USER", userId });
	}

	const where: Prisma.RegisteredAgentWhereInput = {
		OR: scopeConditions,
		...(framework && { framework }),
		...(status && { status }),
		...(scope && { scope }),
	};

	return db.registeredAgent.findMany({
		where,
		orderBy: { createdAt: "desc" },
		take: limit,
		skip: offset,
	});
}

/**
 * Get registered agent by ID
 */
export async function getRegisteredAgentById(
	id: string,
): Promise<RegisteredAgent | null> {
	return db.registeredAgent.findUnique({
		where: { id },
	});
}

/**
 * Get registered agent by agentId (unique identifier)
 */
export async function getRegisteredAgentByAgentId(
	agentId: string,
): Promise<RegisteredAgent | null> {
	return db.registeredAgent.findUnique({
		where: { agentId },
	});
}

/**
 * Create a new registered agent
 */
export async function createRegisteredAgent(data: {
	agentId: string;
	name: string;
	displayName: string;
	description?: string;
	framework: string;
	deploymentUrl?: string;
	userId?: string;
	organizationId?: string;
	scope?: string;
	config?: Prisma.InputJsonValue;
	metadata?: Prisma.InputJsonValue;
	status?: string;
}): Promise<RegisteredAgent> {
	return db.registeredAgent.create({
		data: {
			agentId: data.agentId,
			name: data.name,
			displayName: data.displayName,
			description: data.description,
			framework: data.framework,
			deploymentUrl: data.deploymentUrl,
			userId: data.userId,
			organizationId: data.organizationId,
			scope: data.scope || "USER",
			config: data.config,
			metadata: data.metadata,
			status: data.status || "ACTIVE",
		},
	});
}

/**
 * Update registered agent
 */
export async function updateRegisteredAgent(
	id: string,
	data: {
		name?: string;
		displayName?: string;
		description?: string;
		deploymentUrl?: string;
		status?: string;
		config?: Prisma.InputJsonValue;
		metadata?: Prisma.InputJsonValue;
		lastHealthCheck?: Date;
	},
): Promise<RegisteredAgent> {
	return db.registeredAgent.update({
		where: { id },
		data,
	});
}

/**
 * Delete registered agent
 */
export async function deleteRegisteredAgent(
	id: string,
): Promise<RegisteredAgent> {
	return db.registeredAgent.delete({
		where: { id },
	});
}

/**
 * Count registered agents for a tenant
 */
export async function countRegisteredAgents({
	userId,
	organizationId,
	framework,
	status,
}: {
	userId: string;
	organizationId?: string;
	framework?: string;
	status?: string;
}): Promise<number> {
	const where: Prisma.RegisteredAgentWhereInput = {
		OR: [
			{ scope: "USER", userId },
			...(organizationId
				? [{ scope: "ORGANIZATION", organizationId }]
				: []),
			{ scope: "SYSTEM" },
		],
		...(framework && { framework }),
		...(status && { status }),
	};

	return db.registeredAgent.count({ where });
}

/** Consecutive failed probes required before an agent is marked ERROR. */
export const HEALTH_FAILURE_THRESHOLD = 3;

/**
 * Pure decision for how a health-check outcome changes an agent's row.
 * A healthy probe clears everything; failures increment a counter and only flip
 * the status to ERROR once they reach HEALTH_FAILURE_THRESHOLD (so a single
 * transient blip never alarms).
 */
export function computeHealthCheckUpdate(
	prev: { status: string; consecutiveHealthFailures: number },
	healthy: boolean,
	error?: string,
): {
	status: string;
	consecutiveHealthFailures: number;
	lastHealthError: string | null;
} {
	if (healthy) {
		return {
			status: "ACTIVE",
			consecutiveHealthFailures: 0,
			lastHealthError: null,
		};
	}
	const consecutiveHealthFailures = prev.consecutiveHealthFailures + 1;
	return {
		status:
			consecutiveHealthFailures >= HEALTH_FAILURE_THRESHOLD
				? "ERROR"
				: prev.status,
		consecutiveHealthFailures,
		lastHealthError: error ?? "Health check failed",
	};
}

/**
 * Update registered agent health check (threshold-aware).
 */
export async function updateRegisteredAgentHealthCheck(
	agentId: string,
	healthy: boolean,
	error?: string,
): Promise<RegisteredAgent> {
	const prev = await db.registeredAgent.findUniqueOrThrow({
		where: { agentId },
		select: { status: true, consecutiveHealthFailures: true },
	});
	const next = computeHealthCheckUpdate(prev, healthy, error);
	return db.registeredAgent.update({
		where: { agentId },
		data: { ...next, lastHealthCheck: new Date() },
	});
}

/**
 * Get registered agents by their agentIds (for targeted health checks)
 */
export async function getAgentsByIds(
	agentIds: string[],
): Promise<RegisteredAgent[]> {
	return db.registeredAgent.findMany({
		where: { agentId: { in: agentIds } },
	});
}

/**
 * Get agents that need a health check (never checked or checked more than maxAgeMinutes ago)
 */
export async function getAgentsNeedingHealthCheck(
	maxAgeMinutes = 5,
): Promise<RegisteredAgent[]> {
	const staleThreshold = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
	return db.registeredAgent.findMany({
		where: {
			// Include ACTIVE, ERROR, and STALE agents so that unhealthy agents
			// can automatically recover once their endpoint becomes healthy again.
			status: { in: ["ACTIVE", "ERROR", "STALE"] },
			deploymentUrl: { not: null },
			OR: [
				{ lastHealthCheck: null },
				{ lastHealthCheck: { lt: staleThreshold } },
			],
		},
	});
}

/**
 * Bulk-update agents with stale health checks to "STALE" status
 * Returns count of agents updated
 */
export async function markStaleAgentsInactive(
	staleThresholdMinutes = 10,
): Promise<number> {
	const staleThreshold = new Date(
		Date.now() - staleThresholdMinutes * 60 * 1000,
	);
	const result = await db.registeredAgent.updateMany({
		where: {
			status: "ACTIVE",
			// Only stale-check probeable agents. In-process FABRIC_NATIVE agents and
			// inline agents (empty deploymentUrl) are never probed, so their
			// lastHealthCheck never refreshes — marking them STALE would be a false
			// signal. Mirrors isProbeableAgent in @repo/temporal (kept in sync by
			// hand; the layering forbids importing it here). See #1685.
			framework: { not: "FABRIC_NATIVE" },
			deploymentUrl: { not: null },
			NOT: { deploymentUrl: "" },
			lastHealthCheck: { lt: staleThreshold },
		},
		data: { status: "STALE" },
	});
	return result.count;
}

/**
 * Self-heal non-probeable agents back to ACTIVE.
 *
 * In-process FABRIC_NATIVE agents and inline agents (empty deploymentUrl) have
 * no /health endpoint, so they are never probed and can never recover via a
 * healthy probe. If they were ever left STALE or ERROR (e.g. by an older
 * monitor build, or a deploy-order race with a one-shot migration), nothing
 * else flips them back. Running this every monitor cycle keeps them ACTIVE
 * regardless of timing. Mirrors isProbeableAgent in @repo/temporal (kept in
 * sync by hand; the layering forbids importing it here). See #1685.
 *
 * Returns the count of agents reactivated.
 */
export async function reactivateNonProbeableAgents(): Promise<number> {
	const result = await db.registeredAgent.updateMany({
		where: {
			status: { in: ["STALE", "ERROR"] },
			OR: [
				{ framework: "FABRIC_NATIVE" },
				{ deploymentUrl: null },
				{ deploymentUrl: "" },
			],
		},
		data: {
			status: "ACTIVE",
			consecutiveHealthFailures: 0,
			lastHealthError: null,
		},
	});
	return result.count;
}

/**
 * Update the agent card cache stored in the metadata JSON field.
 *
 * Merges only the `agentCard` and `agentCardCachedAt` keys into the existing
 * metadata object so that other metadata fields (skills, tags, protocols, etc.)
 * are preserved.
 */
export async function updateAgentCardCache(
	agentId: string,
	agentCard: Record<string, unknown>,
	cachedAt: Date,
): Promise<void> {
	// Read current metadata first, then merge to avoid overwriting other keys
	const agent = await db.registeredAgent.findUnique({
		where: { agentId },
		select: { metadata: true },
	});

	const existingMetadata =
		(agent?.metadata as Record<string, unknown> | null) ?? {};

	const updatedMetadata: Record<string, unknown> = {
		...existingMetadata,
		agentCard,
		agentCardCachedAt: cachedAt.toISOString(),
	};

	await db.registeredAgent.update({
		where: { agentId },
		data: { metadata: updatedMetadata as Prisma.InputJsonValue },
	});
}

/**
 * Update the description embedding stored in the metadata JSON field.
 *
 * Merges only the `descriptionEmbedding` and `embeddingGeneratedAt` keys into
 * the existing metadata object so that other metadata fields are preserved.
 * Same pattern as updateAgentCardCache.
 */
export async function updateAgentEmbedding(
	agentId: string,
	embedding: number[],
	embeddingGeneratedAt: Date,
	/** The embedding model ID used to generate this vector (e.g. "openai/text-embedding-3-small"). */
	embeddingModelId?: string,
): Promise<void> {
	const agent = await db.registeredAgent.findUnique({
		where: { agentId },
		select: { metadata: true },
	});

	const existingMetadata =
		(agent?.metadata as Record<string, unknown> | null) ?? {};

	const updatedMetadata: Record<string, unknown> = {
		...existingMetadata,
		descriptionEmbedding: embedding,
		embeddingGeneratedAt: embeddingGeneratedAt.toISOString(),
		...(embeddingModelId && { embeddingModelId }),
	};

	await db.registeredAgent.update({
		where: { agentId },
		data: { metadata: updatedMetadata as Prisma.InputJsonValue },
	});
}

/**
 * Get agents with their cached description embeddings.
 *
 * Returns active agents in scope (using XOR tenant isolation), each decorated
 * with a `cachedEmbedding` property pulled from `metadata.descriptionEmbedding`.
 * Returns `null` for `cachedEmbedding` when no pre-computed embedding is stored.
 */
export async function getAgentsWithEmbeddings({
	userId,
	organizationId,
	status,
}: {
	userId: string;
	organizationId?: string;
	status?: string;
}): Promise<
	Array<
		RegisteredAgent & {
			cachedEmbedding: number[] | null;
			cachedEmbeddingModel: string | null;
		}
	>
> {
	// XOR PATTERN: Strict context isolation
	const scopeConditions: Prisma.RegisteredAgentWhereInput[] = [
		{ scope: "SYSTEM" },
	];

	if (organizationId) {
		// ORGANIZATION CONTEXT: SYSTEM + ORG agents only
		scopeConditions.push({ scope: "ORGANIZATION", organizationId });
	} else {
		// PERSONAL CONTEXT: SYSTEM + USER agents only
		scopeConditions.push({ scope: "USER", userId });
	}

	const agents = await db.registeredAgent.findMany({
		where: {
			OR: scopeConditions,
			...(status && { status }),
		},
	});

	return agents.map((agent) => {
		const meta = agent.metadata as Record<string, unknown> | null;
		const raw = meta?.descriptionEmbedding;
		const cachedEmbedding =
			Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "number"
				? (raw as number[])
				: null;
		const cachedEmbeddingModel =
			typeof meta?.embeddingModelId === "string"
				? meta.embeddingModelId
				: null;
		return { ...agent, cachedEmbedding, cachedEmbeddingModel };
	});
}

/**
 * Get active A2A agents for orchestrator routing
 */
export async function getActiveA2AAgents({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string;
}): Promise<RegisteredAgent[]> {
	return db.registeredAgent.findMany({
		where: {
			framework: "A2A",
			status: "ACTIVE",
			OR: [
				{ scope: "USER", userId },
				...(organizationId
					? [{ scope: "ORGANIZATION", organizationId }]
					: []),
				{ scope: "SYSTEM" },
			],
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Find active A2A agents that have any of the given capability tags in their metadata.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT: SYSTEM + ORGANIZATION agents only
 * - PERSONAL CONTEXT: SYSTEM + USER agents only
 *
 * Tags are matched against `metadata.tags` and `metadata.skills[*].id` fields.
 * Since Prisma JSON path filtering for array membership is limited, we fetch all
 * active A2A agents in scope and filter in-memory (agent count is always small).
 *
 * Results are ordered by lastHealthCheck DESC NULLS LAST so the freshest agents
 * come first, giving callers the most-recently-verified options.
 */
export async function findAgentsByCapabilityTag({
	tags,
	userId,
	organizationId,
	excludeAgentId,
}: {
	tags: string[];
	userId: string;
	organizationId?: string;
	excludeAgentId?: string;
}): Promise<RegisteredAgent[]> {
	if (tags.length === 0) {
		return [];
	}

	// XOR PATTERN: Strict context isolation — mirrors getActiveA2AAgents
	const scopeConditions: Prisma.RegisteredAgentWhereInput[] = [
		{ scope: "SYSTEM" },
	];

	if (organizationId) {
		// ORGANIZATION CONTEXT: SYSTEM + ORG agents only
		scopeConditions.push({ scope: "ORGANIZATION", organizationId });
	} else {
		// PERSONAL CONTEXT: SYSTEM + USER agents only
		scopeConditions.push({ scope: "USER", userId });
	}

	const agents = await db.registeredAgent.findMany({
		where: {
			status: "ACTIVE",
			deploymentUrl: { not: null },
			OR: scopeConditions,
			...(excludeAgentId && { agentId: { not: excludeAgentId } }),
		},
		orderBy: [
			// Freshest health-checked agents first; agents never checked sort last
			{ lastHealthCheck: { sort: "desc", nulls: "last" } },
		],
	});

	// Filter in-memory: agent must support A2A protocol AND have at least one
	// matching tag from metadata.tags or metadata.skills[*].id
	const normalizedTags = tags.map((t) => t.toLowerCase());

	return agents.filter((agent) => {
		const metadata = agent.metadata as Record<string, unknown> | null;
		if (!metadata) {
			return false;
		}

		// Must support A2A protocol
		const protocols = (metadata.protocols as string[] | undefined) ?? [];
		const supportsA2A = protocols.some((p) => p.toLowerCase() === "a2a");
		if (!supportsA2A) {
			return false;
		}

		// Check metadata.tags array
		const metaTags = (metadata.tags as string[] | undefined) ?? [];
		const tagMatches = metaTags.some((t) =>
			normalizedTags.includes(t.toLowerCase()),
		);
		if (tagMatches) {
			return true;
		}

		// Check metadata.skills[*].id
		const skills =
			(metadata.skills as
				| Array<{ id: string; name?: string; description?: string }>
				| undefined) ?? [];
		return skills.some((s) => normalizedTags.includes(s.id.toLowerCase()));
	});
}
