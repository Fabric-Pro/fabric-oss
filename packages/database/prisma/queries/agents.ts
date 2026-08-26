/**
 * Database queries for Agent Registry
 */

import { db } from "../client";
// Import enums from generated client
import type {
	Agent,
	AgentFramework,
	AgentScope,
	AgentStatus,
	Prisma,
} from "../generated/client";

/**
 * List agents for a tenant (user or organization)
 * Enforces strict isolation between personal and organizational agents:
 * - When organizationId is provided: only show agents for that organization
 * - When organizationId is NOT provided: only show personal agents (organizationId = null)
 */
export async function listAgents({
	userId,
	organizationId,
	framework,
	status,
	limit = 50,
	offset = 0,
}: {
	userId: string;
	organizationId?: string;
	framework?: AgentFramework;
	status?: AgentStatus;
	limit?: number;
	offset?: number;
}): Promise<Agent[]> {
	// Strict isolation: if no organizationId, only show personal agents (null org)
	// If organizationId provided, only show that org's agents
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentWhereInput = {
		userId,
		...orgFilter,
		...(framework && { framework }),
		...(status && { status }),
	};

	return await db.agent.findMany({
		where,
		orderBy: { createdAt: "desc" },
		take: limit,
		skip: offset,
	});
}

/**
 * Get agent by ID with tenant filtering
 *
 * SECURITY: Always include tenant context to prevent ID enumeration attacks.
 * User-owned pattern: org context sees org agents, personal context sees personal agents.
 *
 * @param id - Agent ID
 * @param opts - Tenant context (userId required, organizationId optional)
 */
export async function getAgentById(
	id: string,
	opts?: { userId: string; organizationId?: string },
): Promise<Agent | null> {
	// If no tenant context, return null (security: prevent ID enumeration)
	if (!opts?.userId) {
		return null;
	}

	return await db.agent.findFirst({
		where: {
			id,
			userId: opts.userId,
			organizationId: opts.organizationId ?? null,
		},
	});
}

/**
 * Get agent by agentId (unique identifier).
 *
 * ⚠️  DANGER — NO TENANT FILTER.
 *
 * This helper returns an agent matched by its unique `agentId` string without
 * any tenant scoping. It exists only for trusted server-side contexts that
 * have ALREADY authenticated the caller and are about to apply their own
 * tenant check (e.g. runtime API-key flows like
 * `packages/api/modules/runtime/procedures/get-agent.ts`).
 *
 * For user-facing / session-authenticated callers, use a scope-aware
 * `db.agent.findFirst` with `{ OR: [{ scope: "SYSTEM" }, { scope: "USER",
 * userId }, { scope: "ORGANIZATION", organizationId }] }` — this is what
 * the `agents.registry.getConfig` procedure does.
 */
export async function getAgentByAgentId(
	agentId: string,
): Promise<Agent | null> {
	return await db.agent.findUnique({
		where: { agentId },
	});
}

/**
 * Create a new agent
 */
export async function createAgent(data: {
	agentId: string;
	name: string;
	displayName: string;
	description?: string;
	framework: AgentFramework;
	runtimeVersion?: string;
	deploymentUrl?: string | null;
	userId: string;
	organizationId?: string;
	scope?: AgentScope;
	config?: Prisma.InputJsonValue;
	metadata?: Prisma.InputJsonValue;
	status?: AgentStatus;
}): Promise<Agent> {
	return await db.agent.create({
		data: {
			...data,
			runtimeVersion: data.runtimeVersion || "v1",
			deploymentUrl: data.deploymentUrl || null,
			scope: data.scope || "USER",
			status: data.status || "ACTIVE", // Default to ACTIVE for multi-tenant
		},
	});
}

/**
 * Update agent
 */
export async function updateAgent(
	id: string,
	data: {
		name?: string;
		displayName?: string;
		description?: string;
		runtimeVersion?: string;
		deploymentUrl?: string | null;
		status?: AgentStatus;
		config?: Prisma.InputJsonValue;
		metadata?: Prisma.InputJsonValue;
		lastHealthCheck?: Date;
		lastDeployedAt?: Date;
	},
): Promise<Agent> {
	return await db.agent.update({
		where: { id },
		data,
	});
}

/**
 * Delete agent
 */
export async function deleteAgent(id: string): Promise<Agent> {
	return await db.agent.delete({
		where: { id },
	});
}

/**
 * Count agents for a tenant
 * Enforces strict isolation between personal and organizational agents
 */
export async function countAgents({
	userId,
	organizationId,
	framework,
	status,
}: {
	userId: string;
	organizationId?: string;
	framework?: AgentFramework;
	status?: AgentStatus;
}): Promise<number> {
	// Strict isolation: if no organizationId, only count personal agents
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentWhereInput = {
		userId,
		...orgFilter,
		...(framework && { framework }),
		...(status && { status }),
	};

	return await db.agent.count({ where });
}

/**
 * Update agent health check timestamp
 */
export async function updateAgentHealthCheck(id: string): Promise<Agent> {
	return await db.agent.update({
		where: { id },
		data: {
			lastHealthCheck: new Date(),
		},
	});
}

/**
 * Get agents by framework
 * Enforces strict isolation between personal and organizational agents
 */
export async function getAgentsByFramework(
	framework: AgentFramework,
	userId: string,
	organizationId?: string,
): Promise<Agent[]> {
	// Strict isolation: if no organizationId, only get personal agents
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agent.findMany({
		where: {
			framework,
			userId,
			...orgFilter,
		},
		orderBy: { createdAt: "desc" },
	});
}
