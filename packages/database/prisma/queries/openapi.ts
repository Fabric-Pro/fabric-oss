/**
 * OpenAPI Service and Tool Database Queries
 *
 * Multi-tenant queries for managing OpenAPI services and their extracted tools.
 * Follows the same patterns as MCP queries for consistency.
 */

import { db } from "../client";
import type { Prisma } from "../generated/client";
import type {
	OpenAPIAuthLocation,
	OpenAPIAuthType,
	OpenAPIServiceStatus,
} from "../zod";

// ============================================================================
// OpenAPI Service Queries
// ============================================================================

export interface CreateOpenAPIServiceInput {
	name: string;
	specUrl: string;
	specHash: string;
	baseUrl?: string | null;
	description?: string | null;
	authType?: OpenAPIAuthType;
	authLocation?: OpenAPIAuthLocation | null;
	authKey?: string | null;
	encryptedAuthValue?: string | null;
	oauth2TokenUrl?: string | null;
	oauth2AuthUrl?: string | null;
	oauth2ClientId?: string | null;
	encryptedOauth2ClientSecret?: string | null;
	oauth2Scopes?: string[];
	category?: string | null;
	tags?: string[];
	createdById: string;
	userId?: string | null;
	organizationId?: string | null;
}

/**
 * Create a new OpenAPI service
 *
 * Per-user-within-org pattern: userId is required, organizationId is optional
 * 1. Personal: userId set, organizationId null
 * 2. Organization: userId set, organizationId set (user's installation within org)
 */
export async function createOpenAPIService({
	userId,
	organizationId,
	createdById,
	...data
}: CreateOpenAPIServiceInput) {
	if (!userId) {
		throw new Error(
			"OpenAPI service must have a userId (for personal or per-user org installations)",
		);
	}

	return db.openAPIService.create({
		data: {
			name: data.name,
			specUrl: data.specUrl,
			specHash: data.specHash,
			baseUrl: data.baseUrl ?? null,
			description: data.description ?? null,
			authType: data.authType ?? "NONE",
			authLocation: data.authLocation ?? null,
			authKey: data.authKey ?? null,
			encryptedAuthValue: data.encryptedAuthValue ?? null,
			oauth2TokenUrl: data.oauth2TokenUrl ?? null,
			oauth2AuthorizationUrl: data.oauth2AuthUrl ?? null,
			oauth2ClientId: data.oauth2ClientId ?? null,
			encryptedOauth2Secret: data.encryptedOauth2ClientSecret ?? null,
			oauth2Scopes: data.oauth2Scopes ?? [],
			category: data.category ?? null,
			tags: data.tags ?? [],
			status: "ACTIVE",
			createdById,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
		},
		include: { tools: true },
	});
}

/**
 * List OpenAPI services for a tenant
 *
 * Per-user-within-org pattern:
 * - In org context: returns user's services within that org
 * - In personal context: returns user's personal services only
 */
export async function listOpenAPIServicesForTenant({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	if (!userId) {
		return [];
	}

	return db.openAPIService.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
		},
		include: {
			tools: {
				where: { enabled: true },
				orderBy: { name: "asc" },
			},
			_count: { select: { tools: true } },
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get an OpenAPI service by ID with authorization check
 */
export async function getOpenAPIServiceById({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId?: string;
	organizationId?: string;
}) {
	const service = await db.openAPIService.findFirst({
		where: {
			id,
			...(organizationId
				? { organizationId, userId }
				: { userId, organizationId: null }),
		},
		include: {
			tools: { orderBy: { name: "asc" } },
			configs: true,
		},
	});

	return service;
}

/**
 * Update an OpenAPI service
 */
export async function updateOpenAPIService({
	id,
	userId,
	organizationId,
	data,
}: {
	id: string;
	userId?: string;
	organizationId?: string;
	data: Partial<{
		name: string;
		description: string | null;
		baseUrl: string | null;
		authType: OpenAPIAuthType;
		authLocation: OpenAPIAuthLocation | null;
		authKey: string | null;
		encryptedAuthValue: string | null;
		oauth2TokenUrl: string | null;
		oauth2AuthUrl: string | null;
		oauth2ClientId: string | null;
		encryptedOauth2ClientSecret: string | null;
		oauth2Scopes: string[];
		category: string | null;
		tags: string[];
		status: OpenAPIServiceStatus;
		specHash: string;
	}>;
}) {
	const existing = await db.openAPIService.findFirst({
		where: {
			id,
			...(organizationId
				? { organizationId, userId }
				: { userId, organizationId: null }),
		},
	});
	if (!existing) {
		throw new Error("OpenAPI service not found");
	}

	return db.openAPIService.update({
		where: { id },
		data,
		include: { tools: true },
	});
}

/**
 * Delete an OpenAPI service and all its tools
 */
export async function deleteOpenAPIService({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId?: string;
	organizationId?: string;
}) {
	const existing = await db.openAPIService.findFirst({
		where: {
			id,
			...(organizationId
				? { organizationId, userId }
				: { userId, organizationId: null }),
		},
	});
	if (!existing) {
		return { success: true };
	}

	// Cascade delete tools and configs
	await db.openAPITool.deleteMany({ where: { serviceId: id } });
	await db.openAPIServiceConfig.deleteMany({ where: { serviceId: id } });
	await db.openAPIService.delete({ where: { id } });

	return { success: true };
}

/**
 * Sync (refresh) tools from an OpenAPI service
 * Replaces existing tools with new ones from parsed spec
 */
export async function syncOpenAPIServiceTools({
	serviceId,
	specHash,
	tools,
}: {
	serviceId: string;
	specHash: string;
	tools: Array<{
		operationId: string;
		name: string;
		description: string | null;
		method: string;
		path: string;
		parametersSchema: Record<string, unknown> | null;
		requestBodySchema: Record<string, unknown> | null;
		responseSchema: Record<string, unknown> | null;
		deprecated: boolean;
		tags: string[];
	}>;
}) {
	// Delete existing tools
	await db.openAPITool.deleteMany({ where: { serviceId } });

	// Create new tools one by one (createManyAndReturn doesn't support Json fields well)
	const createdTools = [];
	for (const tool of tools) {
		const created = await db.openAPITool.create({
			data: {
				serviceId,
				operationId: tool.operationId,
				name: tool.name,
				description: tool.description,
				method: tool.method,
				path: tool.path,
				parametersSchema: (tool.parametersSchema ?? undefined) as
					| Prisma.InputJsonValue
					| undefined,
				requestBodySchema: (tool.requestBodySchema ?? undefined) as
					| Prisma.InputJsonValue
					| undefined,
				responseSchema: (tool.responseSchema ?? undefined) as
					| Prisma.InputJsonValue
					| undefined,
				deprecated: tool.deprecated,
				tags: tool.tags,
				enabled: !tool.deprecated, // Disable deprecated tools by default
			},
		});
		createdTools.push(created);
	}

	// Update service spec hash and sync timestamp
	await db.openAPIService.update({
		where: { id: serviceId },
		data: { specHash, lastSyncedAt: new Date() },
	});

	return createdTools;
}

// ============================================================================
// OpenAPI Tool Queries
// ============================================================================

/**
 * Get all enabled tools for a service
 */
export async function getEnabledToolsForService(serviceId: string) {
	return db.openAPITool.findMany({
		where: { serviceId, enabled: true },
		orderBy: { name: "asc" },
	});
}

/**
 * Get a tool by ID
 */
export async function getOpenAPIToolById(id: string) {
	return db.openAPITool.findUnique({
		where: { id },
		include: { service: true },
	});
}

/**
 * Toggle tool enabled status
 */
export async function setOpenAPIToolEnabled({
	id,
	enabled,
}: {
	id: string;
	enabled: boolean;
}) {
	return db.openAPITool.update({
		where: { id },
		data: { enabled },
	});
}

/**
 * Update tool usage statistics
 */
export async function recordToolUsage({
	id,
	responseTime,
	success,
}: {
	id: string;
	responseTime: number;
	success: boolean;
}) {
	const tool = await db.openAPITool.findUnique({ where: { id } });
	if (!tool) {
		return null;
	}

	// Calculate new averages
	const newUseCount = tool.useCount + 1;
	const newAvgResponseTime =
		(tool.avgResponseTime * tool.useCount + responseTime) / newUseCount;
	const newErrorRate = success
		? (tool.errorRate * tool.useCount) / newUseCount
		: (tool.errorRate * tool.useCount + 1) / newUseCount;

	return db.openAPITool.update({
		where: { id },
		data: {
			useCount: newUseCount,
			avgResponseTime: newAvgResponseTime,
			errorRate: newErrorRate,
			lastUsedAt: new Date(),
		},
	});
}

// ============================================================================
// OpenAPI Service Config Queries (per-user/org overrides)
// ============================================================================

/**
 * Get or create a config for a user/org and service
 *
 * Service configs follow the per-user-within-org pattern:
 * 1. Personal only: userId set, organizationId null
 * 2. Per-user within org: userId set, organizationId set (user's config within org context)
 * At minimum, userId must be provided.
 */
export async function getOrCreateOpenAPIServiceConfig({
	serviceId,
	userId,
	organizationId,
}: {
	serviceId: string;
	userId?: string;
	organizationId?: string;
}) {
	if (!userId) {
		throw new Error(
			"Service config must have a userId (for personal or per-user org configs)",
		);
	}

	const existing = await db.openAPIServiceConfig.findFirst({
		where: {
			serviceId,
			userId,
			organizationId: organizationId ?? null,
		},
	});

	if (existing) {
		return existing;
	}

	return db.openAPIServiceConfig.create({
		data: {
			serviceId,
			userId,
			organizationId: organizationId ?? null,
			enabled: true,
		},
	});
}

/**
 * Update service config overrides
 */
export async function updateOpenAPIServiceConfig({
	id,
	data,
}: {
	id: string;
	data: Partial<{
		enabled: boolean;
		baseUrlOverride: string | null;
		encryptedAuthValueOverride: string | null;
		enabledTools: string[];
		disabledTools: string[];
	}>;
}) {
	return db.openAPIServiceConfig.update({
		where: { id },
		data,
	});
}

/**
 * List all configs for a tenant
 *
 * Follows per-user-within-org pattern:
 * - In org context: returns user's configs within that org
 * - In personal context: returns user's personal configs only
 */
export async function listOpenAPIServiceConfigsForTenant({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	if (!userId) {
		return [];
	}

	return db.openAPIServiceConfig.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
		},
		include: { service: { include: { tools: true } } },
	});
}

// ============================================================================
// Agent Integration Queries
// ============================================================================

/**
 * Get all enabled OpenAPI tools for a tenant
 * Used when loading tools for an agent
 *
 * Per-user-within-org pattern:
 * - In org context: returns user's services within that org
 * - In personal context: returns user's personal services only
 */
export async function getEnabledOpenAPIToolsForTenant({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	if (!userId) {
		return [];
	}

	const whereClause: Prisma.OpenAPIServiceWhereInput = {
		status: "ACTIVE",
		userId,
		organizationId: organizationId ?? null,
	};

	const services = await db.openAPIService.findMany({
		where: whereClause,
		include: {
			tools: {
				where: { enabled: true },
			},
		},
	});

	return services.flatMap((service) =>
		service.tools.map((tool) => ({
			...tool,
			service: {
				id: service.id,
				name: service.name,
				baseUrl: service.baseUrl,
				authType: service.authType,
				authLocation: service.authLocation,
				authKey: service.authKey,
				encryptedAuthValue: service.encryptedAuthValue,
			},
		})),
	);
}

/**
 * Get active OpenAPI services with their enabled tools
 * Used for loading tools into agents at runtime
 *
 * Per-user-within-org pattern:
 * - In org context: returns user's services within that org
 * - In personal context: returns user's personal services only
 */
export async function getActiveOpenAPIServicesWithTools({
	userId,
	organizationId,
	serviceIds,
}: {
	userId?: string;
	organizationId?: string;
	serviceIds?: string[];
}) {
	if (!userId) {
		return [];
	}

	const whereClause: Prisma.OpenAPIServiceWhereInput = {
		status: "ACTIVE",
		userId,
		organizationId: organizationId ?? null,
	};

	// Filter by specific service IDs if provided
	if (serviceIds && serviceIds.length > 0) {
		whereClause.id = { in: serviceIds };
	}

	return db.openAPIService.findMany({
		where: whereClause,
		include: {
			tools: {
				where: { enabled: true },
				orderBy: { name: "asc" },
			},
		},
	});
}
