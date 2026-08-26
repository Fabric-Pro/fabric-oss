/**
 * Database queries for RAG extraction provider configuration
 */

import { db } from "../client";

// ============================================================================
// Organization RAG Provider Queries
// ============================================================================

/**
 * Get all RAG providers for an organization
 */
export async function getOrganizationRagProviders(organizationId: string) {
	return await db.organizationRagProvider.findMany({
		where: { organizationId },
		orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
	});
}

/**
 * Get enabled RAG providers for an organization (sorted by priority)
 */
export async function getEnabledOrganizationRagProviders(
	organizationId: string,
) {
	return await db.organizationRagProvider.findMany({
		where: {
			organizationId,
			enabled: true,
		},
		orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
	});
}

/**
 * Get default RAG provider for an organization
 */
export async function getDefaultOrganizationRagProvider(
	organizationId: string,
) {
	return await db.organizationRagProvider.findFirst({
		where: {
			organizationId,
			isDefault: true,
			enabled: true,
		},
	});
}

/**
 * Get specific RAG provider configuration for an organization
 */
export async function getOrganizationRagProvider({
	organizationId,
	providerName,
}: {
	organizationId: string;
	providerName: string;
}) {
	return await db.organizationRagProvider.findUnique({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
	});
}

/**
 * Create or update organization RAG provider configuration
 */
export async function upsertOrganizationRagProvider({
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
		await db.organizationRagProvider.updateMany({
			where: {
				organizationId,
				isDefault: true,
			},
			data: {
				isDefault: false,
			},
		});
	}

	return await db.organizationRagProvider.upsert({
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
 * Delete organization RAG provider configuration
 */
export async function deleteOrganizationRagProvider({
	organizationId,
	providerName,
}: {
	organizationId: string;
	providerName: string;
}) {
	return await db.organizationRagProvider.delete({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
	});
}

/**
 * Update last used timestamp for organization RAG provider
 */
export async function updateOrganizationRagProviderLastUsed({
	organizationId,
	providerName,
}: {
	organizationId: string;
	providerName: string;
}) {
	return await db.organizationRagProvider.update({
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
 * Increment usage stats for organization RAG provider
 */
export async function incrementOrganizationRagProviderUsage({
	organizationId,
	providerName,
	cost,
}: {
	organizationId: string;
	providerName: string;
	cost: number;
}) {
	return await db.organizationRagProvider.update({
		where: {
			organizationId_providerName: {
				organizationId,
				providerName,
			},
		},
		data: {
			documentsProcessed: { increment: 1 },
			totalCost: { increment: cost },
			lastUsedAt: new Date(),
		},
	});
}

// ============================================================================
// User RAG Provider Queries
// ============================================================================

/**
 * Get all RAG providers for a user
 */
export async function getUserRagProviders(userId: string) {
	return await db.userRagProvider.findMany({
		where: { userId },
		orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
	});
}

/**
 * Get enabled RAG providers for a user (sorted by priority)
 */
export async function getEnabledUserRagProviders(userId: string) {
	return await db.userRagProvider.findMany({
		where: {
			userId,
			enabled: true,
		},
		orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
	});
}

/**
 * Get default RAG provider for a user
 */
export async function getDefaultUserRagProvider(userId: string) {
	return await db.userRagProvider.findFirst({
		where: {
			userId,
			isDefault: true,
			enabled: true,
		},
	});
}

/**
 * Get specific RAG provider configuration for a user
 */
export async function getUserRagProvider({
	userId,
	providerName,
}: {
	userId: string;
	providerName: string;
}) {
	return await db.userRagProvider.findUnique({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
	});
}

/**
 * Create or update user RAG provider configuration
 */
export async function upsertUserRagProvider({
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
		await db.userRagProvider.updateMany({
			where: {
				userId,
				isDefault: true,
			},
			data: {
				isDefault: false,
			},
		});
	}

	return await db.userRagProvider.upsert({
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
 * Delete user RAG provider configuration
 */
export async function deleteUserRagProvider({
	userId,
	providerName,
}: {
	userId: string;
	providerName: string;
}) {
	return await db.userRagProvider.delete({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
	});
}

/**
 * Update last used timestamp for user RAG provider
 */
export async function updateUserRagProviderLastUsed({
	userId,
	providerName,
}: {
	userId: string;
	providerName: string;
}) {
	return await db.userRagProvider.update({
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
 * Increment usage stats for user RAG provider
 * Creates the record if it doesn't exist (upsert)
 */
export async function incrementUserRagProviderUsage({
	userId,
	providerName,
	cost,
}: {
	userId: string;
	providerName: string;
	cost: number;
}) {
	return await db.userRagProvider.upsert({
		where: {
			userId_providerName: {
				userId,
				providerName,
			},
		},
		create: {
			userId,
			providerName,
			documentsProcessed: 1,
			totalCost: cost,
		},
		update: {
			documentsProcessed: { increment: 1 },
			totalCost: { increment: cost },
			lastUsedAt: new Date(),
		},
	});
}
