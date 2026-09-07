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

// The scope vocabulary deliberately does not live here. It is the input
// contract of the create procedure, which owns the `z.enum` that validates it
// (`api/modules/organizations/procedures/api-keys/create.ts`), and it is
// checked against the settings picker and the MCP tool map by test. A second
// copy in this file was unreferenced, listed ten scopes where the procedure
// accepts twenty-two, and omitted `orgs:read` — so the first thing anyone
// debugging a scope problem found was a stale list that pointed the wrong way.

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
 * Verify an API key by hash and return organization context.
 *
 * Three things have to hold, and only two of them live on the key row. The key
 * must exist, be active and unexpired — and its creator must *still* be a
 * member of the organization it was issued for.
 *
 * That last one is the whole point of verifying rather than merely looking up.
 * A key is a claim about who is asking; it is never a claim about what they may
 * do. Permissions come from membership, membership changes, and it changes
 * without anyone thinking about the API keys that person happens to hold. Read
 * live, an offboarded creator loses the key on their next request. Read from
 * the key row, they keep it until a human notices — which is not a revocation
 * story anyone should have to run.
 *
 * Returns `null` for a revoked member, the same answer an inactive or expired
 * key gets, so no caller has to learn a new failure mode and none can
 * distinguish "dead key" from "departed person".
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

	const membership = await db.member.findFirst({
		where: {
			organizationId: apiKey.organizationId,
			userId: apiKey.createdByUserId,
		},
		select: { id: true },
	});

	if (!membership) {
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
