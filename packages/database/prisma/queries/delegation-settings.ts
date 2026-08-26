/**
 * Database queries for Fabric AI delegation settings
 * Controls whether Fabric AI operations run on the server (delegated) or in Temporal (direct)
 */

import { db } from "../client";

/**
 * Get user's delegation setting
 */
export async function getUserDelegationSetting(userId: string) {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: {
			id: true,
			useDelegatedExecution: true,
		},
	});
	return user?.useDelegatedExecution ?? true; // Default to true (delegated)
}

/**
 * Get organization's delegation setting
 */
export async function getOrganizationDelegationSetting(organizationId: string) {
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: {
			id: true,
			useDelegatedExecution: true,
		},
	});
	return org?.useDelegatedExecution ?? true; // Default to true (delegated)
}

/**
 * Update user's delegation setting
 */
export async function updateUserDelegationSetting({
	userId,
	useDelegatedExecution,
}: {
	userId: string;
	useDelegatedExecution: boolean;
}) {
	return await db.user.update({
		where: { id: userId },
		data: {
			useDelegatedExecution,
		},
		select: {
			id: true,
			useDelegatedExecution: true,
		},
	});
}

/**
 * Update organization's delegation setting
 */
export async function updateOrganizationDelegationSetting({
	organizationId,
	useDelegatedExecution,
}: {
	organizationId: string;
	useDelegatedExecution: boolean;
}) {
	return await db.organization.update({
		where: { id: organizationId },
		data: {
			useDelegatedExecution,
		},
		select: {
			id: true,
			useDelegatedExecution: true,
		},
	});
}

/**
 * Get effective delegation setting for a user/organization context
 * Organization setting takes precedence if available
 */
export async function getEffectiveDelegationSetting({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string;
}): Promise<boolean> {
	// If in organization context, use org setting
	if (organizationId) {
		return await getOrganizationDelegationSetting(organizationId);
	}
	// Otherwise use user setting
	return await getUserDelegationSetting(userId);
}
