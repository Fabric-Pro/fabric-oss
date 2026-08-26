/**
 * User API Key queries
 *
 * Manages API keys for external integrations (e.g., MCP Server)
 */

import { db } from "../client";

export interface CreateUserApiKeyParams {
	userId: string;
	name: string;
	keyHash: string;
	keyPrefix: string;
	scopes?: string[];
	expiresAt?: Date;
}

export interface ListUserApiKeysParams {
	userId: string;
	includeInactive?: boolean;
}

/**
 * Create a new API key for a user
 */
export async function createUserApiKey(params: CreateUserApiKeyParams) {
	return db.userApiKey.create({
		data: {
			userId: params.userId,
			name: params.name,
			keyHash: params.keyHash,
			keyPrefix: params.keyPrefix,
			scopes: params.scopes ?? ["mcp:read", "mcp:write"],
			expiresAt: params.expiresAt,
		},
	});
}

/**
 * List all API keys for a user
 */
export async function listUserApiKeys(params: ListUserApiKeysParams) {
	return db.userApiKey.findMany({
		where: {
			userId: params.userId,
			...(params.includeInactive ? {} : { isActive: true }),
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
		},
	});
}

/**
 * Get an API key by ID
 */
export async function getUserApiKeyById(id: string, userId: string) {
	return db.userApiKey.findFirst({
		where: { id, userId },
	});
}

/**
 * Get an API key by prefix for verification
 */
export async function getUserApiKeyByPrefix(keyPrefix: string) {
	return db.userApiKey.findFirst({
		where: { keyPrefix, isActive: true },
	});
}

/**
 * Get an API key by prefix INCLUDING revoked ones.
 *
 * Only for callers that check `isActive` themselves and want to tell "this key
 * was revoked" apart from "no such key" — the public observability REST surface
 * does, so it can answer `API_KEY_REVOKED` instead of a generic
 * `INVALID_API_KEY` that leaves an operator guessing why their key stopped
 * working.
 *
 * Named for the hazard on purpose. Do NOT swap this in for
 * `getUserApiKeyByPrefix` at an existing call site: that helper's `isActive`
 * filter IS the revocation check for callers that do not perform their own.
 */
export async function getUserApiKeyByPrefixIncludingRevoked(keyPrefix: string) {
	return db.userApiKey.findFirst({
		where: { keyPrefix },
	});
}

/**
 * Update API key usage stats
 */
export async function updateUserApiKeyUsage(id: string) {
	return db.userApiKey.update({
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
export async function deactivateUserApiKey(id: string, userId: string) {
	return db.userApiKey.updateMany({
		where: { id, userId },
		data: { isActive: false },
	});
}

/**
 * Delete an API key permanently
 */
export async function deleteUserApiKey(id: string, userId: string) {
	return db.userApiKey.deleteMany({
		where: { id, userId },
	});
}

/**
 * Rename an API key
 */
export async function renameUserApiKey(
	id: string,
	userId: string,
	name: string,
) {
	return db.userApiKey.updateMany({
		where: { id, userId },
		data: { name },
	});
}
