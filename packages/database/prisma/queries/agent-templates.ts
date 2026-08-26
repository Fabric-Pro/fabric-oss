/**
 * Agent Template Database Queries
 *
 * Database operations for the agent template system.
 */

import { generateId } from "../../utils";
import { db } from "../client";
import {
	type AgentInstanceStatus,
	type AgentTemplate,
	type AgentTemplateCategory,
	type AgentTemplateInstance,
	type AgentTemplateScope,
	Prisma,
} from "../generated/client";

// ============================================
// BUILT-IN TOOL MAPPING
// ============================================

/**
 * Maps user-facing built-in tool keys (stored in
 * AgentTemplateInstance.toolConnections) to the Fabric AI tool IDs that
 * back them at runtime. Consumed by both template-mention search and any
 * agent runtime that needs to translate enabled built-in tools into the
 * concrete tool IDs to expose to the LLM.
 */
export const BUILT_IN_TO_FABRIC_TOOLS: Record<string, string[]> = {
	"agent-memory": [],
	"create-frames": [
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_share_frame",
		"fabric_create_slideshow",
	],
	"create-images": ["fabric_generate_image"],
	"run-agent": [],
	"speech-generator": ["fabric_text_to_speech"],
	"web-search-browse": [
		"fabric_web_search",
		"fabric_search_and_analyze",
		"fabric_scrape_url",
		"fabric_scrape_and_analyze",
	],
	"web-search": [
		"fabric_web_search",
		"fabric_search_and_analyze",
		"fabric_scrape_url",
		"fabric_scrape_and_analyze",
	],
	search: ["workspace_rag_query", "workspace_rag_summarize"],
	"code-interpreter": ["fabric_code_interpreter"],
	"image-generation": ["fabric_generate_image"],
	"project-context": ["project_rag_query"],
	"create-story": ["fabric_create_story"],
};

/**
 * Extract the enabled built-in tool keys from an instance's toolConnections
 * JSON. Built-in entries are those that are enabled, do not start with the
 * "mcp:" prefix, and do not carry a connectionId (which would mark them as
 * MCP-backed integrations).
 */
export function extractEnabledBuiltInToolKeys(
	toolConnections: unknown,
): string[] {
	if (!toolConnections || typeof toolConnections !== "object") {
		return [];
	}
	const connections = toolConnections as Record<string, unknown>;
	const keys: string[] = [];
	for (const [key, value] of Object.entries(connections)) {
		const isEnabled =
			value &&
			typeof value === "object" &&
			(value as { enabled?: boolean }).enabled !== false;
		if (!isEnabled) {
			continue;
		}
		if (key.startsWith("mcp:")) {
			continue;
		}
		if (
			value &&
			typeof value === "object" &&
			"connectionId" in value &&
			typeof (value as { connectionId: unknown }).connectionId ===
				"string"
		) {
			continue;
		}
		keys.push(key);
	}
	return keys;
}

/**
 * Translate enabled built-in tool keys into the concrete Fabric AI tool IDs
 * to expose to an LLM via createBuiltInTools.
 */
export function mapBuiltInKeysToFabricToolIds(keys: string[]): string[] {
	const ids: string[] = [];
	for (const key of keys) {
		const mapped = BUILT_IN_TO_FABRIC_TOOLS[key];
		if (mapped) {
			ids.push(...mapped);
		}
	}
	return ids;
}

/**
 * Read the per-tool config object stored on an instance's toolConnections JSON.
 *
 * Built-in tool entries are objects like `{ enabled: true, projectId: "..." }`.
 * Returns the object for a given key when the tool is present and enabled,
 * or `null` otherwise. Callers extract specific fields (e.g., `projectId` for
 * `project-context`) from the result.
 */
export function getBuiltInToolConfig(
	toolConnections: unknown,
	key: string,
): Record<string, unknown> | null {
	if (!toolConnections || typeof toolConnections !== "object") {
		return null;
	}
	const value = (toolConnections as Record<string, unknown>)[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	if ((value as { enabled?: boolean }).enabled === false) {
		return null;
	}
	return value as Record<string, unknown>;
}

// ============================================
// TEMPLATE QUERIES
// ============================================

export interface ListAgentTemplatesParams {
	userId?: string;
	organizationId?: string | null;
	scope?: AgentTemplateScope;
	category?: AgentTemplateCategory;
	tags?: string[];
	search?: string;
	isPublished?: boolean;
	isFeatured?: boolean;
	limit?: number;
	offset?: number;
	sortBy?: "name" | "createdAt" | "updatedAt" | "useCount" | "lastUsedAt";
	sortOrder?: "asc" | "desc";
}

export async function listAgentTemplates(
	params: ListAgentTemplatesParams,
): Promise<{
	templates: AgentTemplate[];
	total: number;
}> {
	const {
		userId,
		organizationId,
		scope,
		category,
		tags,
		search,
		isPublished = true,
		isFeatured,
		limit = 50,
		offset = 0,
		sortBy = "updatedAt",
		sortOrder = "desc",
	} = params;

	// Build where clause
	const where: Prisma.AgentTemplateWhereInput = {
		isPublished,
	};

	// XOR PATTERN: Strict context isolation
	// ORGANIZATION CONTEXT: SYSTEM + ORG templates only
	// PERSONAL CONTEXT: SYSTEM + USER templates only
	if (scope) {
		where.scope = scope;
	} else {
		const scopeConditions: Prisma.AgentTemplateWhereInput[] = [
			{ scope: "SYSTEM" },
		];

		if (organizationId) {
			// ORGANIZATION CONTEXT: SYSTEM + ORG templates only (no personal templates)
			scopeConditions.push({
				scope: "ORGANIZATION" as const,
				organizationId,
			});
		} else if (userId) {
			// PERSONAL CONTEXT: SYSTEM + USER templates only (no org templates)
			scopeConditions.push({ scope: "USER" as const, userId });
		}

		where.OR = scopeConditions;
	}

	if (category) {
		where.category = category;
	}

	if (tags && tags.length > 0) {
		where.tags = { hasSome: tags };
	}

	if (search) {
		where.OR = [
			{ name: { contains: search, mode: "insensitive" } },
			{ displayName: { contains: search, mode: "insensitive" } },
			{ description: { contains: search, mode: "insensitive" } },
		];
	}

	if (isFeatured !== undefined) {
		where.isFeatured = isFeatured;
	}

	const [templates, total] = await Promise.all([
		db.agentTemplate.findMany({
			where,
			orderBy: { [sortBy]: sortOrder },
			skip: offset,
			take: limit,
		}),
		db.agentTemplate.count({ where }),
	]);

	return { templates, total };
}

export async function getAgentTemplate(
	slugOrId: string,
): Promise<AgentTemplate | null> {
	return db.agentTemplate.findFirst({
		where: {
			OR: [{ id: slugOrId }, { slug: slugOrId }],
		},
	});
}

export async function getAgentTemplateBySlug(
	slug: string,
): Promise<AgentTemplate | null> {
	return db.agentTemplate.findUnique({
		where: { slug },
	});
}

export interface CreateAgentTemplateParams {
	slug: string;
	name: string;
	displayName: string;
	description: string;
	instructions: string;
	heroEmojis?: string[];
	heroImageUrl?: string;
	category: AgentTemplateCategory;
	tags?: string[];
	suggestedModel?: string;
	modelConfig?: Prisma.InputJsonValue;
	promptBindingId?: string;
	documentType?: string;
	scope?: AgentTemplateScope;
	userId?: string;
	organizationId?: string;
	isPublished?: boolean;
	isFeatured?: boolean;
}

export async function createAgentTemplate(
	params: CreateAgentTemplateParams,
): Promise<AgentTemplate> {
	return db.agentTemplate.create({
		data: {
			slug: params.slug,
			name: params.name,
			displayName: params.displayName,
			description: params.description,
			instructions: params.instructions,
			heroEmojis: params.heroEmojis || [],
			heroImageUrl: params.heroImageUrl,
			category: params.category,
			tags: params.tags || [],
			suggestedModel: params.suggestedModel,
			modelConfig: params.modelConfig,
			promptBindingId: params.promptBindingId,
			documentType: params.documentType as any,
			scope: params.scope || "USER",
			userId: params.userId,
			organizationId: params.organizationId,
			isPublished: params.isPublished ?? true,
			isFeatured: params.isFeatured ?? false,
		},
	});
}

export interface UpdateAgentTemplateParams {
	id: string;
	name?: string;
	displayName?: string;
	description?: string;
	instructions?: string;
	heroEmojis?: string[];
	heroImageUrl?: string;
	category?: AgentTemplateCategory;
	tags?: string[];
	suggestedModel?: string;
	modelConfig?: Prisma.InputJsonValue;
	isPublished?: boolean;
	isFeatured?: boolean;
}

export async function updateAgentTemplate(
	params: UpdateAgentTemplateParams,
): Promise<AgentTemplate> {
	const { id, ...data } = params;

	return db.agentTemplate.update({
		where: { id },
		data: {
			...data,
			version: { increment: 1 },
		},
	});
}

export async function deleteAgentTemplate(id: string): Promise<void> {
	await db.agentTemplate.delete({ where: { id } });
}

export async function incrementTemplateUseCount(id: string): Promise<void> {
	await db.agentTemplate.update({
		where: { id },
		data: {
			useCount: { increment: 1 },
			lastUsedAt: new Date(),
		},
	});
}

// ============================================
// TEMPLATE INSTANCE QUERIES
// ============================================

export interface ListAgentTemplateInstancesParams {
	userId: string;
	organizationId?: string | null;
	templateId?: string;
	status?: AgentInstanceStatus | AgentInstanceStatus[];
	/** @deprecated Use status instead */
	isActive?: boolean;
	search?: string;
	limit?: number;
	offset?: number;
	sortBy?: "name" | "createdAt" | "updatedAt" | "runCount" | "lastRunAt";
	sortOrder?: "asc" | "desc";
	/** If true, returns only the latest version of each instance (by sId) */
	latestVersionOnly?: boolean;
}

export async function listAgentTemplateInstances(
	params: ListAgentTemplateInstancesParams,
): Promise<{ instances: AgentTemplateInstance[]; total: number }> {
	const {
		userId,
		organizationId,
		templateId,
		status,
		isActive,
		search,
		limit = 50,
		offset = 0,
		sortBy = "updatedAt",
		sortOrder = "desc",
		latestVersionOnly = true, // Default to only showing latest versions
	} = params;

	const where: Prisma.AgentTemplateInstanceWhereInput = {};

	// Filter by ownership
	if (organizationId) {
		where.organizationId = organizationId;
	} else {
		where.userId = userId;
		where.organizationId = null;
	}

	if (templateId) {
		where.templateId = templateId;
	}

	// Status filtering (new versioning-aware approach)
	if (status) {
		if (Array.isArray(status)) {
			where.status = { in: status };
		} else {
			where.status = status;
		}
	} else if (isActive !== undefined) {
		// Backwards compatibility: isActive maps to status
		where.status = isActive ? "ACTIVE" : "ARCHIVED";
	} else {
		// Default: only show ACTIVE instances
		where.status = "ACTIVE";
	}

	// Store search conditions separately - apply AFTER computing latest versions
	const searchConditions = search
		? [
				{ name: { contains: search, mode: "insensitive" as const } },
				{
					description: {
						contains: search,
						mode: "insensitive" as const,
					},
				},
			]
		: null;

	// If latestVersionOnly, we need to filter to only the highest version per sId
	// IMPORTANT: Compute latest versions BEFORE applying search filter
	// This ensures searching for "old-name" doesn't return an older version
	// when the latest version has been renamed to "new-name"
	if (latestVersionOnly) {
		// First, get the max version for each sId using base criteria (WITHOUT search)
		// The `where` at this point contains only ownership and status filters
		const latestVersions = await db.agentTemplateInstance.groupBy({
			by: ["sId"],
			where, // Does NOT include search conditions yet
			_max: {
				version: true,
			},
		});

		// Build version conditions for each sId + max version
		if (latestVersions.length > 0) {
			const versionConditions = latestVersions.map((lv) => ({
				sId: lv.sId,
				version: lv._max.version || 1,
			}));

			// Now combine: (latest version) AND optionally (search matches)
			if (searchConditions) {
				// Use AND to combine: (latest version) AND (search matches)
				where.AND = [
					{ OR: versionConditions },
					{ OR: searchConditions },
				];
			} else {
				where.OR = versionConditions;
			}
		} else if (searchConditions) {
			// No instances found, but still apply search conditions
			// (will return empty results, but maintains correct behavior)
			where.OR = searchConditions;
		}
	} else if (searchConditions) {
		// Not filtering by latest version, just apply search
		where.OR = searchConditions;
	}

	const [instances, total] = await Promise.all([
		db.agentTemplateInstance.findMany({
			where,
			include: {
				template: {
					select: {
						slug: true,
						name: true,
						displayName: true,
						category: true,
						heroEmojis: true,
						instructions: true,
					},
				},
				mcpServerConfigurations: {
					select: { mcpConfigId: true },
				},
			},
			orderBy: { [sortBy]: sortOrder },
			skip: offset,
			take: limit,
		}),
		db.agentTemplateInstance.count({ where }),
	]);

	return { instances: instances as AgentTemplateInstance[], total };
}

export async function getAgentTemplateInstance(
	id: string,
): Promise<AgentTemplateInstance | null> {
	return db.agentTemplateInstance.findUnique({
		where: { id },
		include: {
			template: true,
			integrationConfigurations: {
				where: { isEnabled: true },
				include: {
					integration: {
						select: {
							id: true,
							provider: true,
							name: true,
						},
					},
				},
			},
		},
	}) as Promise<AgentTemplateInstance | null>;
}

/**
 * Get an instance with its full template details for workflow routing.
 * Validates tenant access using XOR pattern.
 *
 * @param instanceId - The ID of the instance
 * @param userId - The user ID for access validation
 * @param organizationId - The organization ID (null for personal context)
 * @returns Instance with template or null if not found/unauthorized
 */
export async function getInstanceWithTemplate(
	instanceId: string,
	userId: string,
	organizationId?: string | null,
): Promise<
	| (AgentTemplateInstance & {
			template: {
				id: string;
				slug: string;
				name: string;
				displayName: string;
				description: string;
				category: AgentTemplateCategory;
				heroEmojis: string[];
				instructions: string;
				suggestedModel: string | null;
				modelConfig: Prisma.JsonValue;
			};
	  })
	| null
> {
	// XOR PATTERN: Strict tenant isolation
	const tenantFilter = organizationId
		? { organizationId }
		: { userId, organizationId: null };

	const instance = await db.agentTemplateInstance.findFirst({
		where: {
			id: instanceId,
			...tenantFilter,
		},
		include: {
			template: {
				select: {
					id: true,
					slug: true,
					name: true,
					displayName: true,
					description: true,
					category: true,
					heroEmojis: true,
					instructions: true,
					suggestedModel: true,
					modelConfig: true,
				},
			},
		},
	});

	return instance as
		| (AgentTemplateInstance & {
				template: {
					id: string;
					slug: string;
					name: string;
					displayName: string;
					description: string;
					category: AgentTemplateCategory;
					heroEmojis: string[];
					instructions: string;
					suggestedModel: string | null;
					modelConfig: Prisma.JsonValue;
				};
		  })
		| null;
}

export interface CreateAgentTemplateInstanceParams {
	templateId: string;
	userId: string;
	organizationId?: string;
	name: string;
	description?: string;
	heroEmojis?: string[];
	heroImageUrl?: string;
	customInstructions?: Prisma.InputJsonValue;
	/**
	 * Knowledge connections in legacy format: { "PROVIDER": "oauth" | "integration-id" }
	 * This will be converted to AgentIntegrationConfiguration records.
	 * "oauth" markers will be resolved to actual WorkflowIntegration IDs.
	 */
	knowledgeConnections?: Prisma.InputJsonValue;
	/**
	 * Per-provider resource scoping for knowledge connections, e.g. the
	 * Unity Catalog schema + vector indexes selected for a Databricks
	 * Vector Search connection. Keyed by provider type, mirrors
	 * `knowledgeConnections`. Stored on the matching
	 * `AgentIntegrationConfiguration.allowedResources`.
	 */
	knowledgeResources?: Record<string, { schema: string; indexes: string[] }>;
	toolConnections?: Prisma.InputJsonValue;
	triggers?: Prisma.InputJsonValue;
	modelOverride?: string;
	modelConfig?: Prisma.InputJsonValue;
	workspaceIds?: string[];
	// Goal-oriented execution configuration
	executionMode?: string;
	goal?: string;
	successCriteria?: Prisma.InputJsonValue;
	maxIterations?: number;
}

/**
 * OAuth providers that use "oauth" as a marker in knowledgeConnections.
 * For these, we look up the actual WorkflowIntegration ID by provider name.
 */
const OAUTH_PROVIDER_LIST = [
	"GITHUB",
	"GOOGLE_DRIVE",
	"MICROSOFT_GRAPH",
	"SLACK",
	"NOTION",
] as const;

type OAuthProviderType = (typeof OAUTH_PROVIDER_LIST)[number];

function isOAuthProviderType(provider: string): provider is OAuthProviderType {
	return OAUTH_PROVIDER_LIST.includes(provider as OAuthProviderType);
}

export async function createAgentTemplateInstance(
	params: CreateAgentTemplateInstanceParams,
): Promise<AgentTemplateInstance> {
	// Increment template use count
	await incrementTemplateUseCount(params.templateId);

	// Generate a stable sId for this instance (will remain constant across versions)
	const sId = generateId();

	// Parse knowledge connections and resolve OAuth markers to actual integration IDs
	const integrationConfigsToCreate: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: Prisma.InputJsonValue;
	}> = [];

	if (
		params.knowledgeConnections &&
		typeof params.knowledgeConnections === "object"
	) {
		const connections = params.knowledgeConnections as Record<
			string,
			unknown
		>;
		const oauthProvidersToLookup: string[] = [];

		// First pass: collect OAuth providers that need lookup
		for (const [provider, value] of Object.entries(connections)) {
			if (value === "oauth" && isOAuthProviderType(provider)) {
				oauthProvidersToLookup.push(provider);
			} else if (
				typeof value === "string" &&
				value !== "oauth" &&
				value.length > 0
			) {
				// Direct integration ID (not an oauth marker)
				integrationConfigsToCreate.push({
					integrationId: value,
					integrationType: provider,
					allowedResources: params.knowledgeResources?.[provider],
				});
			}
		}

		// Lookup OAuth integrations by provider
		if (oauthProvidersToLookup.length > 0) {
			const oauthIntegrations = await db.workflowIntegration.findMany({
				where: params.organizationId
					? {
							provider: {
								in: oauthProvidersToLookup as OAuthProviderType[],
							},
							organizationId: params.organizationId,
							isActive: true,
						}
					: {
							provider: {
								in: oauthProvidersToLookup as OAuthProviderType[],
							},
							userId: params.userId,
							organizationId: null,
							isActive: true,
						},
				select: {
					id: true,
					provider: true,
				},
			});

			for (const integration of oauthIntegrations) {
				integrationConfigsToCreate.push({
					integrationId: integration.id,
					integrationType: integration.provider,
					allowedResources:
						params.knowledgeResources?.[integration.provider],
				});
			}
		}
	}

	// Create instance with nested integration configurations
	return db.agentTemplateInstance.create({
		data: {
			templateId: params.templateId,
			userId: params.userId,
			organizationId: params.organizationId,
			// Versioning fields
			sId,
			version: 1,
			status: "ACTIVE",
			// User customization
			name: params.name,
			description: params.description,
			heroEmojis: params.heroEmojis || [],
			heroImageUrl: params.heroImageUrl,
			customInstructions: params.customInstructions ?? Prisma.DbNull,
			toolConnections: params.toolConnections ?? {},
			triggers: params.triggers ?? [],
			modelOverride: params.modelOverride,
			modelConfig: params.modelConfig ?? Prisma.DbNull,
			workspaceIds: params.workspaceIds || [],
			// Goal-oriented execution fields
			executionMode: params.executionMode || "single_turn",
			goal: params.goal,
			successCriteria: params.successCriteria ?? Prisma.DbNull,
			maxIterations: params.maxIterations || 10,
			// New pattern: create integration configurations
			integrationConfigurations: {
				create: integrationConfigsToCreate.map((config) => ({
					integrationId: config.integrationId,
					integrationType: config.integrationType,
					isEnabled: true,
					allowedResources: config.allowedResources ?? undefined,
				})),
			},
		},
		include: {
			template: true,
			integrationConfigurations: true,
		},
	}) as Promise<AgentTemplateInstance>;
}

export interface UpdateAgentTemplateInstanceParams {
	id: string;
	userId: string; // Required for OAuth lookup
	organizationId?: string; // Required for OAuth lookup
	name?: string;
	description?: string;
	heroEmojis?: string[];
	heroImageUrl?: string;
	customInstructions?: Prisma.InputJsonValue;
	/**
	 * Knowledge connections in legacy format: { "PROVIDER": "oauth" | "integration-id" }
	 * This will be converted to AgentIntegrationConfiguration records.
	 */
	knowledgeConnections?: Prisma.InputJsonValue;
	/**
	 * Per-provider resource scoping for knowledge connections. See
	 * {@link CreateAgentTemplateInstanceParams.knowledgeResources}.
	 */
	knowledgeResources?: Record<string, { schema: string; indexes: string[] }>;
	toolConnections?: Prisma.InputJsonValue;
	triggers?: Prisma.InputJsonValue;
	modelOverride?: string;
	modelConfig?: Prisma.InputJsonValue;
	workspaceIds?: string[];
	status?: AgentInstanceStatus;
	// Goal-oriented fields
	executionMode?: string;
	goal?: string;
	successCriteria?: Prisma.InputJsonValue;
	maxIterations?: number;
	// External API exposure
	isApiExposed?: boolean;
	apiConfig?: Prisma.InputJsonValue;
	/**
	 * If true, creates a new version instead of updating in place.
	 * The old version will be archived, and a new version with incremented
	 * version number will be created with the updates applied.
	 * @default false for minor updates, true for significant changes
	 */
	createNewVersion?: boolean;
}

/**
 * Resolve knowledgeConnections to integration configuration records.
 * Handles both "oauth" markers and direct integration IDs.
 */
async function resolveKnowledgeConnectionsToConfigs(
	knowledgeConnections: Prisma.InputJsonValue | undefined,
	userId: string,
	organizationId?: string,
	knowledgeResources?: Record<string, { schema: string; indexes: string[] }>,
): Promise<
	Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: Prisma.InputJsonValue;
	}>
> {
	const configs: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: Prisma.InputJsonValue;
	}> = [];

	if (!knowledgeConnections || typeof knowledgeConnections !== "object") {
		return configs;
	}

	const connections = knowledgeConnections as Record<string, unknown>;
	const oauthProvidersToLookup: string[] = [];

	// First pass: collect OAuth providers that need lookup
	for (const [provider, value] of Object.entries(connections)) {
		if (value === "oauth" && isOAuthProviderType(provider)) {
			oauthProvidersToLookup.push(provider);
		} else if (
			typeof value === "string" &&
			value !== "oauth" &&
			value.length > 0
		) {
			// Direct integration ID
			configs.push({
				integrationId: value,
				integrationType: provider,
				allowedResources: knowledgeResources?.[provider],
			});
		}
	}

	// Lookup OAuth integrations by provider
	if (oauthProvidersToLookup.length > 0) {
		const oauthIntegrations = await db.workflowIntegration.findMany({
			where: organizationId
				? {
						provider: {
							in: oauthProvidersToLookup as OAuthProviderType[],
						},
						organizationId,
						isActive: true,
					}
				: {
						provider: {
							in: oauthProvidersToLookup as OAuthProviderType[],
						},
						userId,
						organizationId: null,
						isActive: true,
					},
			select: {
				id: true,
				provider: true,
			},
		});

		for (const integration of oauthIntegrations) {
			configs.push({
				integrationId: integration.id,
				integrationType: integration.provider,
				allowedResources: knowledgeResources?.[integration.provider],
			});
		}
	}

	return configs;
}

/**
 * Update an agent template instance.
 *
 * If createNewVersion is true, this will:
 * 1. Archive the current version (status = ARCHIVED)
 * 2. Create a new version with incremented version number
 * 3. Apply the updates to the new version
 *
 * Otherwise, it updates the instance in place (for minor changes).
 */
export async function updateAgentTemplateInstance(
	params: UpdateAgentTemplateInstanceParams,
): Promise<AgentTemplateInstance> {
	const {
		id,
		userId,
		organizationId,
		createNewVersion = false,
		knowledgeConnections,
		knowledgeResources,
		...data
	} = params;

	// Get the current instance (include memory files for version copying)
	const current = await db.agentTemplateInstance.findUnique({
		where: { id },
		include: {
			template: true,
			integrationConfigurations: true,
			memoryFiles: true,
		},
	});

	if (!current) {
		throw new Error(`Agent template instance not found: ${id}`);
	}

	// Resolve knowledge connections if provided
	const integrationConfigsToCreate = knowledgeConnections
		? await resolveKnowledgeConnectionsToConfigs(
				knowledgeConnections,
				userId,
				organizationId,
				knowledgeResources,
			)
		: null;

	if (createNewVersion) {
		// Archive current version and create new one
		return db.$transaction(async (tx) => {
			// Archive the current version
			await tx.agentTemplateInstance.update({
				where: { id },
				data: { status: "ARCHIVED" },
			});

			// Create new version with updates
			// Helper to handle JSON fields (convert null to Prisma.DbNull)
			const jsonOrDbNull = <T>(
				value: T | null,
			): T | typeof Prisma.DbNull =>
				value === null ? Prisma.DbNull : value;

			const newVersion = await tx.agentTemplateInstance.create({
				data: {
					// Copy from current
					templateId: current.templateId,
					userId: current.userId,
					organizationId: current.organizationId,
					sId: current.sId, // Keep same sId
					version: current.version + 1, // Increment version
					status: "ACTIVE",
					name: data.name ?? current.name,
					description: data.description ?? current.description,
					heroEmojis: data.heroEmojis ?? current.heroEmojis,
					heroImageUrl: data.heroImageUrl ?? current.heroImageUrl,
					customInstructions: jsonOrDbNull(
						data.customInstructions ?? current.customInstructions,
					),
					toolConnections:
						(data.toolConnections as Prisma.InputJsonValue) ??
						current.toolConnections ??
						{},
					triggers:
						(data.triggers as Prisma.InputJsonValue) ??
						current.triggers ??
						[],
					modelOverride: data.modelOverride ?? current.modelOverride,
					modelConfig: jsonOrDbNull(
						data.modelConfig ?? current.modelConfig,
					),
					workspaceIds: data.workspaceIds ?? current.workspaceIds,
					executionMode: data.executionMode ?? current.executionMode,
					goal: data.goal ?? current.goal,
					successCriteria: jsonOrDbNull(
						data.successCriteria ?? current.successCriteria,
					),
					maxIterations: data.maxIterations ?? current.maxIterations,
					memoryAutoApprove: current.memoryAutoApprove,
					isApiExposed: data.isApiExposed ?? current.isApiExposed,
					apiConfig: jsonOrDbNull(
						data.apiConfig ?? current.apiConfig,
					),
					// Reset usage stats for new version
					runCount: 0,
					lastRunAt: null,
					// New pattern: create integration configurations
					integrationConfigurations: integrationConfigsToCreate
						? {
								create: integrationConfigsToCreate.map(
									(config) => ({
										integrationId: config.integrationId,
										integrationType: config.integrationType,
										isEnabled: true,
										allowedResources:
											config.allowedResources ??
											undefined,
									}),
								),
							}
						: {
								// Copy from current version if no new connections provided
								create: current.integrationConfigurations.map(
									(ic) => ({
										integrationId: ic.integrationId,
										integrationType: ic.integrationType,
										isEnabled: ic.isEnabled,
										allowedResources: ic.allowedResources as
											| Prisma.InputJsonValue
											| undefined,
										timeFrameDuration: ic.timeFrameDuration,
										timeFrameUnit: ic.timeFrameUnit,
										accessLevel: ic.accessLevel,
									}),
								),
							},
				},
				include: { template: true, integrationConfigurations: true },
			});

			// Copy memory files (skills, instructions, etc.) to new version
			if (current.memoryFiles.length > 0) {
				await tx.agentMemoryFile.createMany({
					data: current.memoryFiles.map((mf) => ({
						agentInstanceId: newVersion.id,
						userId: mf.userId,
						organizationId: mf.organizationId,
						path: mf.path,
						fileType: mf.fileType,
						content: mf.content,
						contentHash: mf.contentHash,
						version: mf.version,
						isValid: mf.isValid,
						validationError: mf.validationError,
						lastModifiedBy: mf.lastModifiedBy,
						sourceSkillId: mf.sourceSkillId,
						isEnabled: mf.isEnabled,
					})),
				});
			}

			// Re-point AgentDeployment (and its triggers/metrics, which FK to
			// the deployment id, not the instance) from the archived row to the
			// new version. agentDeployment.instanceId is unique, so without
			// this transfer the deployment + triggers are orphaned on the
			// archived version and a fresh duplicate gets created on the next
			// syncDeploymentTriggers call.
			await tx.agentDeployment.updateMany({
				where: { instanceId: id },
				data: { instanceId: newVersion.id },
			});

			return newVersion as AgentTemplateInstance;
		});
	}

	// Simple in-place update (no versioning)
	// If knowledge connections provided, update integration configurations
	if (integrationConfigsToCreate) {
		await db.$transaction(async (tx) => {
			// Delete existing integration configurations
			await tx.agentIntegrationConfiguration.deleteMany({
				where: { instanceId: id },
			});
			// Create new ones
			await tx.agentIntegrationConfiguration.createMany({
				data: integrationConfigsToCreate.map((config) => ({
					instanceId: id,
					integrationId: config.integrationId,
					integrationType: config.integrationType,
					isEnabled: true,
					allowedResources: config.allowedResources ?? undefined,
				})),
			});
		});
	}

	// Update the instance
	return db.agentTemplateInstance.update({
		where: { id },
		data,
		include: {
			template: true,
			integrationConfigurations: true,
		},
	}) as Promise<AgentTemplateInstance>;
}

export async function deleteAgentTemplateInstance(id: string): Promise<void> {
	// Get the sId of the instance being deleted
	const instance = await db.agentTemplateInstance.findUnique({
		where: { id },
		select: { sId: true },
	});

	if (instance) {
		// Delete all versions with the same sId (including archived versions)
		await db.agentTemplateInstance.deleteMany({
			where: { sId: instance.sId },
		});
	}
}

export async function incrementInstanceRunCount(id: string): Promise<void> {
	await db.agentTemplateInstance.update({
		where: { id },
		data: {
			runCount: { increment: 1 },
			lastRunAt: new Date(),
		},
	});
}

// ============================================
// CATEGORY AGGREGATION
// ============================================

export async function getAgentTemplateCategories(): Promise<
	{ category: AgentTemplateCategory; count: number }[]
> {
	const result = await db.agentTemplate.groupBy({
		by: ["category"],
		where: {
			isPublished: true,
			scope: "SYSTEM",
		},
		_count: {
			category: true,
		},
		orderBy: {
			category: "asc",
		},
	});

	return result.map((r) => ({
		category: r.category,
		count: r._count.category,
	}));
}

// ============================================
// FEATURED TEMPLATES
// ============================================

export async function getFeaturedAgentTemplates(
	limit = 4,
): Promise<AgentTemplate[]> {
	return db.agentTemplate.findMany({
		where: {
			isPublished: true,
			isFeatured: true,
			scope: "SYSTEM",
		},
		orderBy: { useCount: "desc" },
		take: limit,
	});
}

// ============================================
// INSTANCE VERSIONING QUERIES
// ============================================

/**
 * Get the latest (highest version) of an instance by its stable sId.
 */
export async function getLatestInstanceVersion(
	sId: string,
): Promise<AgentTemplateInstance | null> {
	return db.agentTemplateInstance.findFirst({
		where: { sId },
		orderBy: { version: "desc" },
		include: {
			template: true,
			integrationConfigurations: {
				where: { isEnabled: true },
				include: {
					integration: {
						select: {
							id: true,
							provider: true,
							name: true,
						},
					},
				},
			},
		},
	}) as Promise<AgentTemplateInstance | null>;
}

/**
 * Get a specific version of an instance.
 */
export async function getInstanceVersion(
	sId: string,
	version: number,
): Promise<AgentTemplateInstance | null> {
	return db.agentTemplateInstance.findUnique({
		where: {
			sId_version: { sId, version },
		},
		include: {
			template: true,
			integrationConfigurations: {
				where: { isEnabled: true },
				include: {
					integration: {
						select: {
							id: true,
							provider: true,
							name: true,
						},
					},
				},
			},
			memoryFiles: {
				where: { fileType: "SKILL", isEnabled: true },
				select: {
					id: true,
					path: true,
					content: true,
					sourceSkillId: true,
				},
			},
		},
	}) as Promise<AgentTemplateInstance | null>;
}

/**
 * Get the active version of an instance (status = ACTIVE).
 * There should typically be only one active version per sId.
 */
export async function getActiveInstanceVersion(
	sId: string,
): Promise<AgentTemplateInstance | null> {
	return db.agentTemplateInstance.findFirst({
		where: { sId, status: "ACTIVE" },
		include: {
			template: true,
			integrationConfigurations: {
				where: { isEnabled: true },
				include: {
					integration: {
						select: {
							id: true,
							provider: true,
							name: true,
						},
					},
				},
			},
			memoryFiles: {
				where: { fileType: "SKILL", isEnabled: true },
				select: {
					id: true,
					path: true,
					content: true,
					sourceSkillId: true,
				},
			},
		},
	}) as Promise<AgentTemplateInstance | null>;
}

/**
 * Get the version history for an instance (all versions, sorted by version desc).
 */
export async function getInstanceVersionHistory(
	sId: string,
	options?: { limit?: number; includeArchived?: boolean },
): Promise<AgentTemplateInstance[]> {
	const where: Prisma.AgentTemplateInstanceWhereInput = { sId };

	if (!options?.includeArchived) {
		// By default, show all versions (including archived) for history
		// But if explicitly set to false, only show non-archived
		where.status = { not: "ARCHIVED" };
	}

	return db.agentTemplateInstance.findMany({
		where,
		orderBy: { version: "desc" },
		take: options?.limit,
		include: {
			template: {
				select: {
					slug: true,
					name: true,
					displayName: true,
					category: true,
				},
			},
			integrationConfigurations: {
				where: { isEnabled: true },
				include: {
					integration: {
						select: {
							id: true,
							provider: true,
							name: true,
						},
					},
				},
			},
		},
	}) as Promise<AgentTemplateInstance[]>;
}

/**
 * Archive a specific instance version (soft delete).
 */
export async function archiveInstanceVersion(
	id: string,
): Promise<AgentTemplateInstance> {
	return db.agentTemplateInstance.update({
		where: { id },
		data: { status: "ARCHIVED" },
		include: { template: true },
	}) as Promise<AgentTemplateInstance>;
}

/**
 * Restore an archived version by creating a new version from it.
 * This does NOT reactivate the old version - it creates a copy as the new latest.
 */
// ============================================
// TEMPLATE MENTION SEARCH
// ============================================

export interface MentionableTemplate {
	id: string;
	slug: string;
	displayName: string;
	description: string;
	category: AgentTemplateCategory;
	heroEmojis: string[];
	instructions: string;
	/** Skills attached to this template (from Skill catalog) */
	skills: Array<{ name: string; content: string }>;
	/** Enabled OAuth integration IDs for this template instance */
	enabledIntegrationIds: string[];
	/** Enabled MCP config IDs for this template instance */
	enabledMcpConfigIds: string[];
	/** Enabled Fabric AI tool IDs (selective, from built-in tool config) */
	enabledFabricToolIds: string[];
}

export interface SearchTemplatesForMentionParams {
	query?: string;
	userId: string;
	organizationId?: string | null;
	limit?: number;
}

/**
 * Search template instances for @mention autocomplete.
 *
 * XOR PATTERN: Strict tenant isolation
 * - ORGANIZATION CONTEXT: User's instances within the org
 * - PERSONAL CONTEXT: User's personal instances only
 *
 * Only searches ACTIVE instances (not archived).
 */
export async function searchTemplatesForMention(
	params: SearchTemplatesForMentionParams,
): Promise<MentionableTemplate[]> {
	const { query, userId, organizationId, limit = 10 } = params;

	// Build where clause with XOR pattern for instances
	const where: Prisma.AgentTemplateInstanceWhereInput = {
		userId,
		status: "ACTIVE",
	};

	// XOR PATTERN: Strict context isolation
	if (organizationId) {
		// ORGANIZATION CONTEXT: User's instances in this org only
		where.organizationId = organizationId;
	} else {
		// PERSONAL CONTEXT: User's personal instances only (no org)
		where.organizationId = null;
	}

	// Add search filter if query provided
	if (query?.trim()) {
		const searchTerm = query.trim();
		where.OR = [
			{ name: { contains: searchTerm, mode: "insensitive" } },
			{ description: { contains: searchTerm, mode: "insensitive" } },
		];
	}

	const instances = await db.agentTemplateInstance.findMany({
		where,
		select: {
			id: true,
			name: true,
			description: true,
			heroEmojis: true,
			customInstructions: true,
			// Legacy field: { "tool-name": { connectionId: "..." } }
			toolConnections: true,
			template: {
				select: {
					slug: true,
					category: true,
					instructions: true,
				},
			},
			// Skills are materialized as memory files on the instance
			memoryFiles: {
				where: { fileType: "SKILL", isEnabled: true },
				select: {
					path: true,
					content: true,
					sourceSkill: {
						select: { name: true },
					},
				},
				orderBy: { path: "asc" },
			},
			// New pattern: relation to AgentIntegrationConfiguration
			integrationConfigurations: {
				where: { isEnabled: true },
				select: { integrationId: true },
			},
			// New pattern: relation to AgentMCPServerConfiguration
			mcpServerConfigurations: {
				select: { mcpConfigId: true },
			},
		},
		orderBy: { runCount: "desc" },
		take: limit,
	});

	// Map instances to MentionableTemplate format
	return instances.map((instance) => {
		// Extract integration IDs from integrationConfigurations relation
		const enabledIntegrationIds = instance.integrationConfigurations.map(
			(ic) => ic.integrationId,
		);

		// Extract MCP config IDs from mcpServerConfigurations relation
		const mcpConfigIds = instance.mcpServerConfigurations.map(
			(mc) => mc.mcpConfigId,
		);

		// Extract MCP config IDs from legacy toolConnections JSON (still supported)
		// Format: { "tool-name": { "connectionId": "mcp-config-id" } }
		const legacyMcpConfigIds: string[] = [];
		const enabledBuiltInKeys: string[] = [];
		if (
			instance.toolConnections &&
			typeof instance.toolConnections === "object"
		) {
			const connections = instance.toolConnections as Record<
				string,
				unknown
			>;
			for (const [key, value] of Object.entries(connections)) {
				// Check if entry is enabled
				const isEnabled =
					value &&
					typeof value === "object" &&
					(value as { enabled?: boolean }).enabled !== false;
				if (!isEnabled) {
					continue;
				}

				if (key.startsWith("mcp:")) {
					// MCP server config with "mcp:" prefix (new format from ToolsSheet)
					legacyMcpConfigIds.push(key.slice(4));
				} else if (
					value &&
					typeof value === "object" &&
					"connectionId" in value
				) {
					// Legacy format: { "tool-name": { "connectionId": "mcp-config-id" } }
					const connectionId = (value as { connectionId: unknown })
						.connectionId;
					if (
						typeof connectionId === "string" &&
						connectionId.length > 0
					) {
						legacyMcpConfigIds.push(connectionId);
					}
				} else {
					// Built-in tool (enabled:true, no connectionId, no mcp: prefix)
					enabledBuiltInKeys.push(key);
				}
			}
			if (enabledBuiltInKeys.length > 0) {
				// Add fabric-ai-server to MCP config IDs so ToolIndex doesn't
				// blanket-exclude all Fabric AI tools at the config level
				legacyMcpConfigIds.push("fabric-ai-server");
			}
		}

		// Merge and deduplicate MCP config IDs
		const enabledMcpConfigIds = [
			...new Set([...mcpConfigIds, ...legacyMcpConfigIds]),
		];

		// Map built-in tool keys to specific Fabric AI tool IDs
		// Mapping is module-scoped (BUILT_IN_TO_FABRIC_TOOLS) so other agent
		// runtimes can reuse the same translation.
		const enabledFabricToolIds =
			mapBuiltInKeysToFabricToolIds(enabledBuiltInKeys);

		const customInstructions =
			instance.customInstructions &&
			typeof instance.customInstructions === "object" &&
			!Array.isArray(instance.customInstructions)
				? (instance.customInstructions as Record<string, unknown>)
				: null;
		const instructionParts = [instance.template.instructions.trim()];
		if (
			typeof customInstructions?.role === "string" &&
			customInstructions.role.trim()
		) {
			instructionParts.push(customInstructions.role.trim());
		}
		if (
			typeof customInstructions?.additionalContext === "string" &&
			customInstructions.additionalContext.trim()
		) {
			instructionParts.push(customInstructions.additionalContext.trim());
		}
		if (
			typeof customInstructions?.constraints === "string" &&
			customInstructions.constraints.trim()
		) {
			instructionParts.push(
				`Constraints:\n${customInstructions.constraints.trim()}`,
			);
		}

		// Extract skills from instance memory files (materialized from Skill catalog)
		const skills = instance.memoryFiles.map((mf) => ({
			name:
				mf.sourceSkill?.name ||
				mf.path.replace("skills/", "").replace("/SKILL.md", ""),
			content: mf.content,
		}));

		return {
			id: instance.id,
			slug: instance.template.slug,
			displayName: instance.name,
			description: instance.description || "",
			category: instance.template.category,
			heroEmojis: instance.heroEmojis,
			instructions: instructionParts.filter(Boolean).join("\n\n"),
			skills,
			enabledIntegrationIds,
			enabledMcpConfigIds,
			enabledFabricToolIds,
		};
	});
}

export async function restoreInstanceVersion(
	id: string,
): Promise<AgentTemplateInstance> {
	const archived = await db.agentTemplateInstance.findUnique({
		where: { id },
		include: {
			integrationConfigurations: true,
		},
	});

	if (!archived) {
		throw new Error(`Instance not found: ${id}`);
	}

	return db.$transaction(async (tx) => {
		// Get the current max version for this sId
		const maxVersion = await tx.agentTemplateInstance.aggregate({
			where: { sId: archived.sId },
			_max: { version: true },
		});

		const newVersion = (maxVersion._max.version || 0) + 1;

		// Find the currently active version (so we can transfer its deployment
		// to the restored version below).
		const previousActive = await tx.agentTemplateInstance.findFirst({
			where: { sId: archived.sId, status: "ACTIVE" },
			select: { id: true },
		});

		// Archive any currently active version
		await tx.agentTemplateInstance.updateMany({
			where: { sId: archived.sId, status: "ACTIVE" },
			data: { status: "ARCHIVED" },
		});

		// Create new version as a copy of the archived one
		const newInstance = await tx.agentTemplateInstance.create({
			data: {
				templateId: archived.templateId,
				userId: archived.userId,
				organizationId: archived.organizationId,
				sId: archived.sId,
				version: newVersion,
				status: "ACTIVE",
				name: archived.name,
				description: archived.description,
				heroEmojis: archived.heroEmojis,
				heroImageUrl: archived.heroImageUrl,
				customInstructions:
					archived.customInstructions ?? Prisma.DbNull,
				toolConnections: archived.toolConnections ?? {},
				triggers: archived.triggers ?? [],
				modelOverride: archived.modelOverride,
				modelConfig: archived.modelConfig ?? Prisma.DbNull,
				workspaceIds: archived.workspaceIds,
				executionMode: archived.executionMode,
				goal: archived.goal,
				successCriteria: archived.successCriteria ?? Prisma.DbNull,
				maxIterations: archived.maxIterations,
				memoryAutoApprove: archived.memoryAutoApprove,
				runCount: 0,
				lastRunAt: null,
			},
			include: { template: true },
		});

		// Clone integrationConfigurations from archived instance
		if (archived.integrationConfigurations.length > 0) {
			await tx.agentIntegrationConfiguration.createMany({
				data: archived.integrationConfigurations.map((ic) => ({
					instanceId: newInstance.id,
					integrationId: ic.integrationId,
					integrationType: ic.integrationType,
					isEnabled: ic.isEnabled,
					accessLevel: ic.accessLevel,
					allowedResources: ic.allowedResources ?? Prisma.DbNull,
					timeFrameDuration: ic.timeFrameDuration,
					timeFrameUnit: ic.timeFrameUnit,
				})),
			});
		}

		// Re-point the deployment (if any) from the previously-active version
		// to the restored version so triggers/metrics stay attached.
		if (previousActive) {
			await tx.agentDeployment.updateMany({
				where: { instanceId: previousActive.id },
				data: { instanceId: newInstance.id },
			});
		}

		return newInstance as AgentTemplateInstance;
	});
}

/**
 * Create a pending instance (captures sId early, awaiting full configuration).
 * Used in builder UI when user starts creating a new instance.
 */
export async function createPendingInstance(params: {
	templateId: string;
	userId: string;
	organizationId?: string;
	name?: string;
}): Promise<{ sId: string; id: string }> {
	const sId = generateId();

	const instance = await db.agentTemplateInstance.create({
		data: {
			templateId: params.templateId,
			userId: params.userId,
			organizationId: params.organizationId,
			sId,
			version: 0, // Version 0 indicates pending
			status: "PENDING",
			name: params.name || "__PENDING__",
		},
	});

	return { sId: instance.sId, id: instance.id };
}

/**
 * Finalize a pending instance (upgrade to version 1, set status to ACTIVE).
 */
export async function finalizePendingInstance(
	sId: string,
	data: Omit<
		CreateAgentTemplateInstanceParams,
		"templateId" | "userId" | "organizationId"
	>,
): Promise<AgentTemplateInstance> {
	// Find the pending instance
	const pending = await db.agentTemplateInstance.findFirst({
		where: { sId, status: "PENDING" },
	});

	if (!pending) {
		throw new Error(`No pending instance found with sId: ${sId}`);
	}

	// Update to finalized state
	return db.agentTemplateInstance.update({
		where: { id: pending.id },
		data: {
			version: 1,
			status: "ACTIVE",
			name: data.name,
			description: data.description,
			heroEmojis: data.heroEmojis || [],
			heroImageUrl: data.heroImageUrl,
			customInstructions: data.customInstructions ?? Prisma.DbNull,
			toolConnections: data.toolConnections ?? {},
			triggers: data.triggers ?? [],
			modelOverride: data.modelOverride,
			modelConfig: data.modelConfig ?? Prisma.DbNull,
			workspaceIds: data.workspaceIds || [],
			executionMode: data.executionMode || "single_turn",
			goal: data.goal,
			successCriteria: data.successCriteria ?? Prisma.DbNull,
			maxIterations: data.maxIterations || 10,
		},
		include: { template: true },
	}) as Promise<AgentTemplateInstance>;
}
