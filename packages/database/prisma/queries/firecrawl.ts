/**
 * Database queries for Firecrawl API key configuration
 * Handles both user-level and organization-level configuration
 */

import { db } from "../client";

/**
 * Get user's Firecrawl configuration (for personal accounts)
 */
export async function getUserFirecrawlConfig(userId: string) {
	return await db.user.findUnique({
		where: { id: userId },
		select: {
			id: true,
			firecrawlApiKey: true,
			firecrawlEnabled: true,
			firecrawlConfiguredAt: true,
			firecrawlLastUsedAt: true,
		},
	});
}

/**
 * Get organization's Firecrawl configuration
 */
export async function getOrganizationFirecrawlConfig(organizationId: string) {
	return await db.organization.findUnique({
		where: { id: organizationId },
		select: {
			id: true,
			firecrawlApiKey: true,
			firecrawlEnabled: true,
			firecrawlConfiguredAt: true,
			firecrawlLastUsedAt: true,
		},
	});
}

/**
 * Update user's Firecrawl API key (for personal accounts)
 */
export async function updateUserFirecrawlKey({
	userId,
	apiKey,
	enabled,
}: {
	userId: string;
	apiKey: string;
	enabled: boolean;
}) {
	return await db.user.update({
		where: { id: userId },
		data: {
			firecrawlApiKey: apiKey,
			firecrawlEnabled: enabled,
			firecrawlConfiguredAt: new Date(),
		},
		select: {
			id: true,
			firecrawlEnabled: true,
			firecrawlConfiguredAt: true,
		},
	});
}

/**
 * Update organization's Firecrawl API key
 */
export async function updateOrganizationFirecrawlKey({
	organizationId,
	apiKey,
	enabled,
}: {
	organizationId: string;
	apiKey: string;
	enabled: boolean;
}) {
	return await db.organization.update({
		where: { id: organizationId },
		data: {
			firecrawlApiKey: apiKey,
			firecrawlEnabled: enabled,
			firecrawlConfiguredAt: new Date(),
		},
		select: {
			id: true,
			firecrawlEnabled: true,
			firecrawlConfiguredAt: true,
		},
	});
}

/**
 * Delete user's Firecrawl API key
 */
export async function deleteUserFirecrawlKey(userId: string) {
	return await db.user.update({
		where: { id: userId },
		data: {
			firecrawlApiKey: null,
			firecrawlConfiguredAt: null,
			firecrawlLastUsedAt: null,
		},
	});
}

/**
 * Delete organization's Firecrawl API key
 */
export async function deleteOrganizationFirecrawlKey(organizationId: string) {
	return await db.organization.update({
		where: { id: organizationId },
		data: {
			firecrawlApiKey: null,
			firecrawlConfiguredAt: null,
			firecrawlLastUsedAt: null,
		},
	});
}

/**
 * Update last used timestamp for user's Firecrawl
 */
export async function updateUserFirecrawlLastUsed(userId: string) {
	return await db.user.update({
		where: { id: userId },
		data: {
			firecrawlLastUsedAt: new Date(),
		},
	});
}

/**
 * Update last used timestamp for organization's Firecrawl
 */
export async function updateOrganizationFirecrawlLastUsed(
	organizationId: string,
) {
	return await db.organization.update({
		where: { id: organizationId },
		data: {
			firecrawlLastUsedAt: new Date(),
		},
	});
}

/**
 * Update only the 'enabled' flag for a user's Firecrawl configuration
 */
export async function updateUserFirecrawlEnabled({
	userId,
	enabled,
}: {
	userId: string;
	enabled: boolean;
}) {
	return await db.user.update({
		where: { id: userId },
		data: {
			firecrawlEnabled: enabled,
		},
		select: {
			id: true,
			firecrawlEnabled: true,
		},
	});
}
