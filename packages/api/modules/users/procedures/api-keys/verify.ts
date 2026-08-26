/**
 * Verify User API Key
 *
 * Internal utility to verify an API key and return user info.
 * Used by the MCP server to authenticate requests.
 */

import { createHash } from "node:crypto";
import { getUserApiKeyByPrefix, updateUserApiKeyUsage } from "@repo/database";

export interface VerifyApiKeyResult {
	valid: boolean;
	userId?: string;
	scopes?: string[];
	keyId?: string;
	error?: string;
}

/**
 * Verify an API key and return user information
 *
 * @param apiKey - The raw API key (format: fab_<prefix>_<secret>)
 * @param requiredScope - Optional scope to check
 */
export async function verifyUserApiKey(
	apiKey: string,
	requiredScope?: string,
): Promise<VerifyApiKeyResult> {
	// Validate key format
	if (!apiKey || typeof apiKey !== "string") {
		return { valid: false, error: "API key is required" };
	}

	// Parse the key
	const parts = apiKey.split("_");
	if (parts.length < 3 || parts[0] !== "fab") {
		return { valid: false, error: "Invalid API key format" };
	}

	const keyPrefix = `fab_${parts[1]}`;

	// Find the key by prefix
	const storedKey = await getUserApiKeyByPrefix(keyPrefix);

	if (!storedKey) {
		return { valid: false, error: "API key not found" };
	}

	// Check if active
	if (!storedKey.isActive) {
		return { valid: false, error: "API key is inactive" };
	}

	// Check expiration
	if (storedKey.expiresAt && storedKey.expiresAt < new Date()) {
		return { valid: false, error: "API key has expired" };
	}

	// Verify the key hash
	const keyHash = createHash("sha256").update(apiKey).digest("hex");
	if (keyHash !== storedKey.keyHash) {
		return { valid: false, error: "Invalid API key" };
	}

	// Check scope if required
	if (requiredScope && !storedKey.scopes.includes(requiredScope)) {
		return {
			valid: false,
			error: `Missing required scope: ${requiredScope}`,
		};
	}

	// Update usage stats (fire and forget)
	updateUserApiKeyUsage(storedKey.id).catch(() => {
		// Ignore errors in usage tracking
	});

	return {
		valid: true,
		userId: storedKey.userId,
		scopes: storedKey.scopes,
		keyId: storedKey.id,
	};
}
