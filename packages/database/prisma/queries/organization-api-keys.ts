/**
 * Organization API Key queries
 *
 * Manages API keys for organization-level integrations (e.g., external agents, MCP servers)
 * These keys are scoped to the organization and can be used by agents/services
 * to access organization resources with specific permissions.
 */

import { db } from "../client";

export interface CreateOrganizationApiKeyParams {
	organizationId: string;
	createdByUserId: string;
	name: string;
	keyHash: string;
	keyPrefix: string;
	scopes?: string[];
	expiresAt?: Date;
}

export interface ListOrganizationApiKeysParams {
	organizationId: string;
	includeInactive?: boolean;
	createdByUserId?: string;
}

/**
 * Available scopes for organization API keys
 */
export const ORGANIZATION_API_KEY_SCOPES = {
	// MCP scopes
	"mcp:read": "Read MCP server configurations",
	"mcp:write": "Modify MCP server configurations",

	// AI model scopes
	"ai:models:read": "Read available AI models",
	"ai:models:resolve": "Resolve AI model configuration for tasks",

	// Project scopes
	"projects:read": "Read project data",
	"projects:write": "Modify project data",

	// Agent API scopes
	"agents:read": "Read agent metadata and list available agents",
	"agents:execute": "Trigger agent executions via API",
	"agents:stream": "Access real-time execution streams",

	// Wildcard
	"*": "Full access to all organization resources",
} as const;

export type OrganizationApiKeyScope = keyof typeof ORGANIZATION_API_KEY_SCOPES;

/**
 * Create a new API key for an organization
 */
export async function createOrganizationApiKey(
	params: CreateOrganizationApiKeyParams,
) {
	return db.organizationApiKey.create({
		data: {
			organizationId: params.organizationId,
			createdByUserId: params.createdByUserId,
			name: params.name,
			keyHash: params.keyHash,
			keyPrefix: params.keyPrefix,
			scopes: params.scopes ?? ["mcp:read", "mcp:write"],
			expiresAt: params.expiresAt,
		},
	});
}

/**
 * List all API keys for an organization
 */
export async function listOrganizationApiKeys(
	params: ListOrganizationApiKeysParams,
) {
	return db.organizationApiKey.findMany({
		where: {
			organizationId: params.organizationId,
			...(params.includeInactive ? {} : { isActive: true }),
			...(params.createdByUserId
				? { createdByUserId: params.createdByUserId }
				: {}),
		},
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			name: true,
			keyPrefix: true,
			scopes: true,
			expiresAt: true,
			lastUsedAt: true,
			usageCount: true,
			isActive: true,
			createdAt: true,
			createdBy: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
}

/**
 * Get an API key by ID
 */
export async function getOrganizationApiKeyById(
	id: string,
	organizationId: string,
) {
	return db.organizationApiKey.findFirst({
		where: { id, organizationId },
	});
}

/**
 * Get an API key by prefix for verification
 */
export async function getOrganizationApiKeyByPrefix(keyPrefix: string) {
	return db.organizationApiKey.findFirst({
		where: { keyPrefix, isActive: true },
	});
}

/**
 * Get an org API key by prefix INCLUDING revoked ones.
 *
 * Counterpart to `getUserApiKeyByPrefixIncludingRevoked` — see that helper for
 * why this exists and why it must not replace the filtered version at an
 * existing call site.
 */
export async function getOrganizationApiKeyByPrefixIncludingRevoked(
	keyPrefix: string,
) {
	return db.organizationApiKey.findFirst({
		where: { keyPrefix },
	});
}

/**
 * Verify an API key by hash and return organization context
 */
export async function verifyOrganizationApiKey(keyHash: string) {
	const apiKey = await db.organizationApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: {
			id: true,
			organizationId: true,
			createdByUserId: true,
			scopes: true,
		},
	});

	if (!apiKey) {
		return null;
	}

	// Update usage stats
	await db.organizationApiKey.update({
		where: { id: apiKey.id },
		data: {
			lastUsedAt: new Date(),
			usageCount: { increment: 1 },
		},
	});

	return apiKey;
}

/**
 * Update API key usage stats
 */
export async function updateOrganizationApiKeyUsage(id: string) {
	return db.organizationApiKey.update({
		where: { id },
		data: {
			lastUsedAt: new Date(),
			usageCount: { increment: 1 },
		},
	});
}

/**
 * Deactivate an API key (soft delete)
 */
export async function deactivateOrganizationApiKey(
	id: string,
	organizationId: string,
) {
	return db.organizationApiKey.updateMany({
		where: { id, organizationId },
		data: { isActive: false },
	});
}

/**
 * Delete an API key permanently
 *
 * Pass `createdByUserId` to restrict deletion to keys created by a specific
 * user — used to prevent non-owner admins from deleting keys they did not create.
 */
export async function deleteOrganizationApiKey(
	id: string,
	organizationId: string,
	createdByUserId?: string,
) {
	return db.organizationApiKey.deleteMany({
		where: {
			id,
			organizationId,
			...(createdByUserId ? { createdByUserId } : {}),
		},
	});
}

/**
 * Rename an API key
 */
export async function renameOrganizationApiKey(
	id: string,
	organizationId: string,
	name: string,
) {
	return db.organizationApiKey.updateMany({
		where: { id, organizationId },
		data: { name },
	});
}

/**
 * Update API key scopes
 */
export async function updateOrganizationApiKeyScopes(
	id: string,
	organizationId: string,
	scopes: string[],
) {
	return db.organizationApiKey.updateMany({
		where: { id, organizationId },
		data: { scopes },
	});
}
