/**
 * Project Presence Database Queries
 *
 * Handles real-time presence tracking for project collaboration.
 * Stores who is currently viewing/editing a project.
 */

import { db } from "../../client";

export interface UpdatePresenceOptions {
	projectId: string;
	userId: string;
	userName: string;
	userImage?: string;
	activeTab?: string;
	editingDocId?: string;
	// Tenant isolation field
	organizationId?: string;
}

/**
 * Update or create a user's presence in a project
 *
 * TENANT ISOLATION: organizationId is included for proper tenant filtering.
 * userId is already required for presence tracking.
 */
export async function updateProjectPresence(
	options: UpdatePresenceOptions,
): Promise<void> {
	const {
		projectId,
		userId,
		userName,
		userImage,
		activeTab,
		editingDocId,
		organizationId,
	} = options;

	await db.projectPresence.upsert({
		where: {
			projectId_userId: {
				projectId,
				userId,
			},
		},
		create: {
			projectId,
			userId,
			userName,
			userImage,
			activeTab,
			editingDocId,
			lastSeenAt: new Date(),
			organizationId,
		},
		update: {
			userName,
			userImage,
			activeTab,
			editingDocId,
			lastSeenAt: new Date(),
		},
	});
}

/**
 * Remove a user's presence from a project
 */
export async function removeProjectPresence(
	projectId: string,
	userId: string,
): Promise<void> {
	await db.projectPresence.deleteMany({
		where: {
			projectId,
			userId,
		},
	});
}

/**
 * Get all active users in a project
 * Returns users who have been seen in the last 60 seconds
 */
export async function getActiveProjectUsers(projectId: string): Promise<
	Array<{
		userId: string;
		userName: string;
		userImage: string | null;
		activeTab: string | null;
		editingDocId: string | null;
		lastSeenAt: Date;
	}>
> {
	const cutoff = new Date(Date.now() - 60 * 1000); // 60 seconds ago

	return db.projectPresence.findMany({
		where: {
			projectId,
			lastSeenAt: {
				gte: cutoff,
			},
		},
		select: {
			userId: true,
			userName: true,
			userImage: true,
			activeTab: true,
			editingDocId: true,
			lastSeenAt: true,
		},
		orderBy: {
			lastSeenAt: "desc",
		},
	});
}

/**
 * Clean up stale presence records
 * Removes users who haven't been seen in over 2 minutes
 */
export async function cleanupStalePresence(): Promise<number> {
	const cutoff = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago

	const result = await db.projectPresence.deleteMany({
		where: {
			lastSeenAt: {
				lt: cutoff,
			},
		},
	});

	return result.count;
}

/**
 * Check if a user is currently active in a project
 */
export async function isUserActiveInProject(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const cutoff = new Date(Date.now() - 60 * 1000); // 60 seconds ago

	const presence = await db.projectPresence.findUnique({
		where: {
			projectId_userId: {
				projectId,
				userId,
			},
		},
		select: {
			lastSeenAt: true,
		},
	});

	return presence !== null && presence.lastSeenAt >= cutoff;
}
