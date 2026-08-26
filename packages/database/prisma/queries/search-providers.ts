/**
 * Database queries for search provider configuration
 * Used for web search, deep research, video search, etc.
 */

import { db } from "../client";

// ============================================================================
// Organization Search Provider Queries
// ============================================================================

/**
 * Get all search providers for an organization
 */
export async function getOrganizationSearchProviders(organizationId: string) {
	return await db.organizationSearchProvider.findMany({
		where: { organizationId },
		orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
	});
}

/**
 * Get enabled search providers for an organization (sorted by default first, then priority)
 */
export async function getEnabledOrganizationSearchProviders(
	organizationId: string,
) {
	return await db.organizationSearchProvider.findMany({
		where: {
			organizationId,
			enabled: true,
		},
		orderBy: [
			{ isDefault: "desc" },
			{ priority: "asc" },
			{ createdAt: "asc" },
		],
	});
}

/**
 * Get default search provider for an organization
 */
export async function getDefaultOrganizationSearchProvider(
	organizationId: string,
) {
	return await db.organizationSearchProvider.findFirst({
		where: {
			organizationId,
			isDefault: true,
			enabled: true,
		},
	});
}

/**
 * Get specific search provider configuration for an organization
 */
export async function getOrganizationSearchProvider({
	organizationId,
	providerName,
}: {
	organizationId: string;
	providerName: string;
}) {
	return await db.organizationSearchProvider.findUnique({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
	});
}

/**
 * Create or update organization search provider configuration
 */
export async function upsertOrganizationSearchProvider({
	organizationId,
	providerName,
	encryptedApiKey,
	endpoint,
	isDefault,
	priority,
	enabled,
}: {
	organizationId: string;
	providerName: string;
	encryptedApiKey?: string | null;
	endpoint?: string | null;
	isDefault?: boolean;
	priority?: number;
	enabled?: boolean;
}) {
	// If setting as default, unset other defaults first
	if (isDefault) {
		await db.organizationSearchProvider.updateMany({
			where: {
				organizationId,
				isDefault: true,
			},
			data: {
				isDefault: false,
			},
		});
	}

	return await db.organizationSearchProvider.upsert({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
		create: {
			organizationId,
			providerName,
			encryptedApiKey,
			endpoint,
			isDefault: isDefault ?? false,
			priority: priority ?? 0,
			enabled: enabled ?? true,
		},
		update: {
			encryptedApiKey,
			endpoint,
			isDefault,
			priority,
			enabled,
			updatedAt: new Date(),
		},
	});
}

/**
 * Delete organization search provider configuration
 */
export async function deleteOrganizationSearchProvider({
	organizationId,
	providerName,
}: {
	organizationId: string;
	providerName: string;
}) {
	return await db.organizationSearchProvider.delete({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
	});
}

/**
 * Update last used timestamp for organization search provider
 */
export async function updateOrganizationSearchProviderLastUsed({
	organizationId,
	providerName,
}: {
	organizationId: string;
	providerName: string;
}) {
	return await db.organizationSearchProvider.update({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
		data: {
			lastUsedAt: new Date(),
		},
	});
}

/**
 * Increment usage stats for organization search provider
 */
export async function incrementOrganizationSearchProviderUsage({
	organizationId,
	providerName,
	cost,
}: {
	organizationId: string;
	providerName: string;
	cost: number;
}) {
	return await db.organizationSearchProvider.update({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
		data: {
			searchesCount: { increment: 1 },
			totalCost: { increment: cost },
			lastUsedAt: new Date(),
		},
	});
}

// ============================================================================
// User Search Provider Queries
// ============================================================================

/**
 * Get all search providers for a user
 */
export async function getUserSearchProviders(userId: string) {
	return await db.userSearchProvider.findMany({
		where: { userId },
		orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
	});
}

/**
 * Get enabled search providers for a user (sorted by default first, then priority)
 * Also checks for legacy Firecrawl config on User model for backward compatibility
 */
export async function getEnabledUserSearchProviders(userId: string) {
	const providers = await db.userSearchProvider.findMany({
		where: {
			userId,
			enabled: true,
		},
		orderBy: [
			{ isDefault: "desc" },
			{ priority: "asc" },
			{ createdAt: "asc" },
		],
	});

	// Check for legacy Firecrawl config if not already in the new system
	const hasFirecrawl = providers.some((p) => p.providerName === "firecrawl");
	if (!hasFirecrawl) {
		const user = await db.user.findUnique({
			where: { id: userId },
			select: {
				firecrawlApiKey: true,
				firecrawlEnabled: true,
				firecrawlLastUsedAt: true,
			},
		});

		if (user?.firecrawlApiKey && user.firecrawlEnabled) {
			// Add legacy Firecrawl as a provider
			providers.push({
				id: `legacy-firecrawl-${userId}`,
				userId,
				providerName: "firecrawl",
				encryptedApiKey: user.firecrawlApiKey,
				endpoint: null,
				isDefault: false,
				priority: 100,
				enabled: true,
				lastUsedAt: user.firecrawlLastUsedAt,
				searchesCount: 0,
				totalCost: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		}
	}

	return providers;
}

/**
 * Get default search provider for a user
 */
export async function getDefaultUserSearchProvider(userId: string) {
	return await db.userSearchProvider.findFirst({
		where: {
			userId,
			isDefault: true,
			enabled: true,
		},
	});
}

/**
 * Get specific search provider configuration for a user
 */
export async function getUserSearchProvider({
	userId,
	providerName,
}: {
	userId: string;
	providerName: string;
}) {
	return await db.userSearchProvider.findUnique({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
	});
}

/**
 * Create or update user search provider configuration
 */
export async function upsertUserSearchProvider({
	userId,
	providerName,
	encryptedApiKey,
	endpoint,
	isDefault,
	priority,
	enabled,
}: {
	userId: string;
	providerName: string;
	encryptedApiKey?: string | null;
	endpoint?: string | null;
	isDefault?: boolean;
	priority?: number;
	enabled?: boolean;
}) {
	// If setting as default, unset other defaults first
	if (isDefault) {
		await db.userSearchProvider.updateMany({
			where: {
				userId,
				isDefault: true,
			},
			data: {
				isDefault: false,
			},
		});
	}

	return await db.userSearchProvider.upsert({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
		create: {
			userId,
			providerName,
			encryptedApiKey,
			endpoint,
			isDefault: isDefault ?? false,
			priority: priority ?? 0,
			enabled: enabled ?? true,
		},
		update: {
			encryptedApiKey,
			endpoint,
			isDefault,
			priority,
			enabled,
			updatedAt: new Date(),
		},
	});
}

/**
 * Delete user search provider configuration
 */
export async function deleteUserSearchProvider({
	userId,
	providerName,
}: {
	userId: string;
	providerName: string;
}) {
	return await db.userSearchProvider.delete({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
	});
}

/**
 * Update last used timestamp for user search provider
 */
export async function updateUserSearchProviderLastUsed({
	userId,
	providerName,
}: {
	userId: string;
	providerName: string;
}) {
	return await db.userSearchProvider.update({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
		data: {
			lastUsedAt: new Date(),
		},
	});
}

/**
 * Increment usage stats for user search provider
 * Creates the record if it doesn't exist (upsert)
 */
export async function incrementUserSearchProviderUsage({
	userId,
	providerName,
	cost,
}: {
	userId: string;
	providerName: string;
	cost: number;
}) {
	return await db.userSearchProvider.upsert({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
		create: {
			userId,
			providerName,
			searchesCount: 1,
			totalCost: cost,
		},
		update: {
			searchesCount: { increment: 1 },
			totalCost: { increment: cost },
			lastUsedAt: new Date(),
		},
	});
}

/**
 * Get a specific search provider's API key with XOR tenant isolation.
 * Returns the decrypted API key or null if not configured.
 * Also checks legacy Firecrawl config on User/Organization models.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org configs, NO user fallback
 * - PERSONAL CONTEXT (userId only, no organizationId): Only user configs
 */
export async function getSearchProviderConfig({
	userId,
	organizationId,
	providerName,
}: {
	userId: string;
	organizationId?: string;
	providerName: string;
}): Promise<{
	encryptedApiKey: string | null;
	endpoint: string | null;
	enabled: boolean;
	source: "user" | "organization" | "legacy-user" | "legacy-organization";
} | null> {
	// XOR PATTERN: Check context-specific configs ONLY
	// Personal configs NEVER leak into org context and vice versa
	if (organizationId) {
		// ORGANIZATION CONTEXT: Only check org configs
		const orgProvider = await getOrganizationSearchProvider({
			organizationId,
			providerName,
		});
		if (orgProvider?.encryptedApiKey && orgProvider.enabled) {
			return {
				encryptedApiKey: orgProvider.encryptedApiKey,
				endpoint: orgProvider.endpoint,
				enabled: orgProvider.enabled,
				source: "organization",
			};
		}

		// Check legacy Firecrawl on organization if requesting firecrawl
		if (providerName === "firecrawl") {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: {
					firecrawlApiKey: true,
					firecrawlEnabled: true,
				},
			});
			if (org?.firecrawlApiKey && org.firecrawlEnabled) {
				return {
					encryptedApiKey: org.firecrawlApiKey,
					endpoint: null,
					enabled: true,
					source: "legacy-organization",
				};
			}
		}
		// NO FALLBACK to user config in org context - return null if not found
		return null;
	}

	// PERSONAL CONTEXT: Only check user configs
	const userProvider = await getUserSearchProvider({
		userId,
		providerName,
	});
	if (userProvider?.encryptedApiKey && userProvider.enabled) {
		return {
			encryptedApiKey: userProvider.encryptedApiKey,
			endpoint: userProvider.endpoint,
			enabled: userProvider.enabled,
			source: "user",
		};
	}

	// Check legacy Firecrawl on user if requesting firecrawl
	if (providerName === "firecrawl") {
		const user = await db.user.findUnique({
			where: { id: userId },
			select: {
				firecrawlApiKey: true,
				firecrawlEnabled: true,
			},
		});
		if (user?.firecrawlApiKey && user.firecrawlEnabled) {
			return {
				encryptedApiKey: user.firecrawlApiKey,
				endpoint: null,
				enabled: true,
				source: "legacy-user",
			};
		}
	}

	return null;
}

/**
 * Get search provider configurations for a context with XOR tenant isolation.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org configs
 * - PERSONAL CONTEXT (userId only, no organizationId): Only user configs
 *
 * Personal and org configs are NEVER merged - they are mutually exclusive.
 */
export async function getMergedSearchProviderConfigs({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	const configs: Array<{
		providerName: string;
		encryptedApiKey: string | null;
		endpoint: string | null;
		priority: number;
		isDefault: boolean;
		enabled: boolean;
		source: "user" | "organization";
	}> = [];

	// XOR PATTERN: Load ONLY context-specific providers
	// Personal configs NEVER leak into org context and vice versa
	if (organizationId) {
		// ORGANIZATION CONTEXT: Only org configs
		const orgProviders =
			await getEnabledOrganizationSearchProviders(organizationId);
		for (const provider of orgProviders) {
			configs.push({
				providerName: provider.providerName,
				encryptedApiKey: provider.encryptedApiKey,
				endpoint: provider.endpoint,
				priority: provider.priority,
				isDefault: provider.isDefault,
				enabled: provider.enabled,
				source: "organization",
			});
		}
	} else if (userId) {
		// PERSONAL CONTEXT: Only user configs
		const userProviders = await getEnabledUserSearchProviders(userId);
		for (const provider of userProviders) {
			configs.push({
				providerName: provider.providerName,
				encryptedApiKey: provider.encryptedApiKey,
				endpoint: provider.endpoint,
				priority: provider.priority,
				isDefault: provider.isDefault,
				enabled: provider.enabled,
				source: "user",
			});
		}
	}

	// Sort by default first, then priority
	return configs.sort((a, b) => {
		// Default providers come first
		if (a.isDefault !== b.isDefault) {
			return a.isDefault ? -1 : 1;
		}
		// Then sort by priority
		return a.priority - b.priority;
	});
}
