/**
 * Shared Memory Blocks
 * Utilities for managing shared memory across agents in an organization
 */

import type { LettaClient } from "../client";
import type { MemoryBlock, SharedMemoryConfig } from "../types";

/**
 * Organization context that can be shared across agents
 */
export interface OrganizationContext {
	organizationId: string;
	name?: string;
	industry?: string;
	preferences: Record<string, unknown>;
	commonEntities: Array<{
		type: string;
		name: string;
		id?: string;
	}>;
	lastUpdated: string;
}

/**
 * Project context for task-specific shared memory
 */
export interface ProjectContext {
	projectId: string;
	name: string;
	description?: string;
	tools: string[];
	entities: Record<string, unknown>;
	lastUpdated: string;
}

/**
 * Shared memory manager for organization-wide context
 */
export class SharedMemoryManager {
	private client: LettaClient;
	private organizationId: string;
	private cache: Map<string, { value: string; expiresAt: number }> =
		new Map();
	private cacheTtlMs: number;

	constructor(
		client: LettaClient,
		organizationId: string,
		cacheTtlMs = 60000, // 1 minute default
	) {
		this.client = client;
		this.organizationId = organizationId;
		this.cacheTtlMs = cacheTtlMs;
	}

	/**
	 * Get organization context
	 */
	async getOrganizationContext(): Promise<OrganizationContext | null> {
		const key = `org_context_${this.organizationId}`;

		// Check cache
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			return JSON.parse(cached.value);
		}

		// Find orchestrator agent for this org
		const orchestrator = await this.client.findAgentByMetadata({
			organizationId: this.organizationId,
			type: "orchestrator",
		});

		if (!orchestrator) {
			return null;
		}

		try {
			const block = await this.client.getMemoryBlock(
				orchestrator.id,
				"organization_context",
			);
			const context = JSON.parse(block.value) as OrganizationContext;

			// Update cache
			this.cache.set(key, {
				value: block.value,
				expiresAt: Date.now() + this.cacheTtlMs,
			});

			return context;
		} catch {
			return null;
		}
	}

	/**
	 * Update organization context
	 */
	async updateOrganizationContext(
		context: Partial<OrganizationContext>,
	): Promise<void> {
		const orchestrator = await this.client.findAgentByMetadata({
			organizationId: this.organizationId,
			type: "orchestrator",
		});

		if (!orchestrator) {
			throw new Error("No orchestrator agent found for organization");
		}

		const existing = await this.getOrganizationContext();
		const updated: OrganizationContext = {
			organizationId: this.organizationId,
			preferences: {},
			commonEntities: [],
			...existing,
			...context,
			lastUpdated: new Date().toISOString(),
		};

		await this.client.updateMemoryBlock(
			orchestrator.id,
			"organization_context",
			JSON.stringify(updated),
		);

		// Invalidate cache
		this.cache.delete(`org_context_${this.organizationId}`);
	}

	/**
	 * Add a common entity to organization context
	 */
	async addCommonEntity(entity: {
		type: string;
		name: string;
		id?: string;
	}): Promise<void> {
		const context = await this.getOrganizationContext();

		if (!context) {
			await this.updateOrganizationContext({
				commonEntities: [entity],
			});
			return;
		}

		// Check if entity already exists
		const exists = context.commonEntities.some(
			(e) => e.type === entity.type && e.name === entity.name,
		);

		if (!exists) {
			context.commonEntities.push(entity);
			await this.updateOrganizationContext({
				commonEntities: context.commonEntities,
			});
		}
	}

	/**
	 * Sync shared memory to all agents in organization
	 */
	async syncToAllAgents(blockLabel: string, value: string): Promise<number> {
		const agents = await this.client.listAgents({ limit: 100 });

		const orgAgents = agents.filter(
			(a) => a.metadata?.organizationId === this.organizationId,
		);

		let synced = 0;
		for (const agent of orgAgents) {
			try {
				await this.client.updateMemoryBlock(
					agent.id,
					blockLabel,
					value,
				);
				synced++;
			} catch {
				// Agent might not have this block, skip
			}
		}

		return synced;
	}

	/**
	 * Clear cache
	 */
	clearCache(): void {
		this.cache.clear();
	}
}

/**
 * Create a shared memory block configuration
 */
export function createSharedBlockConfig(
	organizationId: string,
	labels: string[],
): SharedMemoryConfig {
	return {
		organizationId,
		blockLabels: labels,
		syncInterval: 60000, // 1 minute
	};
}

/**
 * Standard shared memory block templates
 */
export const SHARED_BLOCK_TEMPLATES: Record<string, MemoryBlock> = {
	organization_context: {
		label: "organization_context",
		value: JSON.stringify({
			organizationId: "",
			preferences: {},
			commonEntities: [],
			lastUpdated: new Date().toISOString(),
		}),
		limit: 20000,
	},
	project_context: {
		label: "project_context",
		value: JSON.stringify({
			projectId: "",
			name: "",
			tools: [],
			entities: {},
			lastUpdated: new Date().toISOString(),
		}),
		limit: 15000,
	},
	tool_results_cache: {
		label: "tool_results_cache",
		value: "{}",
		limit: 50000,
	},
};
