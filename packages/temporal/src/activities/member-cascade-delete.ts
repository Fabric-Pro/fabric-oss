/**
 * Activities for cascading deletion when a user is removed from an organization
 *
 * When a user is removed from an organization, we need to clean up:
 * - Projects owned by the user in that org
 * - Workflows owned by the user in that org
 * - Workspaces owned by the user in that org
 * - Workspace memberships (admin/contributor/stakeholder records)
 * - Project memberships
 * - MCP configs
 * - Agent templates and instances
 * - Other user-owned entities
 *
 * This ensures complete data cleanup and prevents orphaned data
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";

// ============================================================================
// Types
// ============================================================================

export interface MemberCascadeDeleteInput {
	/** The user being removed from the organization */
	userId: string;
	/** The organization the user is being removed from */
	organizationId: string;
	/** Optional: batch size for deletion operations (default: 100) */
	batchSize?: number;
}

export interface MemberCascadeDeleteOutput {
	/** Total number of entities deleted */
	totalDeleted: number;
	/** Breakdown of deletions by entity type */
	deletedCounts: {
		sessionsCleared: number;
		projects: number;
		workflows: number;
		workspaces: number;
		workspaceMemberships: number;
		projectMemberships: number;
		mcpConfigs: number;
		agentTemplateInstances: number;
		chats: number;
	};
	/** Any errors encountered during deletion */
	errors: string[];
}

// ============================================================================
// Activities
// ============================================================================

/**
 * Delete all projects owned by a user in an organization
 */
export async function deleteUserProjectsInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{
	deletedCount: number;
	deletedProjectIds: string[];
	errors: string[];
}> {
	const { userId, organizationId, batchSize = 100 } = input;
	const errors: string[] = [];
	let totalDeleted = 0;
	const deletedProjectIds: string[] = [];

	try {
		logger.info(
			`[MemberCascade] Deleting projects for user ${userId} in org ${organizationId}`,
		);

		// Find all projects owned by this user in this org
		const projects = await db.project.findMany({
			where: {
				userId,
				organizationId,
			},
			select: { id: true, name: true },
			take: batchSize,
		});

		// Delete in batches
		while (projects.length > 0) {
			const projectIds = projects.map((p) => p.id);

			// Delete projects (cascade will handle related records)
			const result = await db.project.deleteMany({
				where: {
					id: { in: projectIds },
					userId, // Double-check ownership
					organizationId,
				},
			});

			totalDeleted += result.count;
			// Capture the IDs of the projects whose rows were just deleted so the
			// workflow can reclaim their R2 attachment objects (the FK cascade
			// removes StoryAttachment rows, not the underlying objects).
			deletedProjectIds.push(...projectIds);
			logger.info(
				`[MemberCascade] Deleted ${result.count} projects in batch`,
			);

			// Get next batch
			const nextBatch = await db.project.findMany({
				where: {
					userId,
					organizationId,
				},
				select: { id: true, name: true },
				take: batchSize,
			});

			if (nextBatch.length === 0) {
				break;
			}
			projects.length = 0;
			projects.push(...nextBatch);
		}

		logger.info(
			`[MemberCascade] Deleted ${totalDeleted} total projects for user ${userId}`,
		);

		return { deletedCount: totalDeleted, deletedProjectIds, errors };
	} catch (error) {
		const errorMsg = `Failed to delete projects: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, deletedProjectIds, errors };
	}
}

/**
 * Delete all workflows owned by a user in an organization
 */
export async function deleteUserWorkflowsInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId, batchSize = 100 } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Deleting workflows for user ${userId} in org ${organizationId}`,
		);

		// Delete workflows in batches
		let hasMore = true;
		while (hasMore) {
			const workflows = await db.workflow.findMany({
				where: {
					userId,
					organizationId,
				},
				select: { id: true },
				take: batchSize,
			});

			if (workflows.length === 0) {
				hasMore = false;
				break;
			}

			const workflowIds = workflows.map((w) => w.id);

			const result = await db.workflow.deleteMany({
				where: {
					id: { in: workflowIds },
					userId,
					organizationId,
				},
			});

			totalDeleted += result.count;
			logger.info(
				`[MemberCascade] Deleted ${result.count} workflows in batch`,
			);
		}

		logger.info(
			`[MemberCascade] Deleted ${totalDeleted} total workflows for user ${userId}`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to delete workflows: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}

/**
 * Delete all workspaces owned by a user in an organization
 */
export async function deleteUserWorkspacesInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId, batchSize = 100 } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Deleting workspaces for user ${userId} in org ${organizationId}`,
		);

		// Delete workspaces in batches
		let hasMore = true;
		while (hasMore) {
			const workspaces = await db.workspace.findMany({
				where: {
					userId,
					organizationId,
				},
				select: { id: true },
				take: batchSize,
			});

			if (workspaces.length === 0) {
				hasMore = false;
				break;
			}

			const workspaceIds = workspaces.map((w) => w.id);

			const result = await db.workspace.deleteMany({
				where: {
					id: { in: workspaceIds },
					userId,
					organizationId,
				},
			});

			totalDeleted += result.count;
			logger.info(
				`[MemberCascade] Deleted ${result.count} workspaces in batch`,
			);
		}

		logger.info(
			`[MemberCascade] Deleted ${totalDeleted} total workspaces for user ${userId}`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to delete workspaces: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}

/**
 * Remove user from all workspace memberships in an organization
 * (administrator, contributor, stakeholder roles)
 */
export async function removeUserWorkspaceMembershipsInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Removing workspace memberships for user ${userId} in org ${organizationId}`,
		);

		// Get all workspaces in this org
		const orgWorkspaces = await db.workspace.findMany({
			where: { organizationId },
			select: { id: true },
		});

		const workspaceIds = orgWorkspaces.map((w) => w.id);

		if (workspaceIds.length === 0) {
			return { deletedCount: 0, errors };
		}

		// Remove from administrators
		const adminResult = await db.workspaceAdministrator.deleteMany({
			where: {
				userId,
				workspaceId: { in: workspaceIds },
			},
		});
		totalDeleted += adminResult.count;

		// Remove from contributors
		const contributorResult = await db.workspaceContributor.deleteMany({
			where: {
				userId,
				workspaceId: { in: workspaceIds },
			},
		});
		totalDeleted += contributorResult.count;

		// Remove from stakeholders
		const stakeholderResult = await db.workspaceStakeholder.deleteMany({
			where: {
				userId,
				workspaceId: { in: workspaceIds },
			},
		});
		totalDeleted += stakeholderResult.count;

		logger.info(
			`[MemberCascade] Removed ${totalDeleted} workspace memberships (admin: ${adminResult.count}, contributor: ${contributorResult.count}, stakeholder: ${stakeholderResult.count})`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to remove workspace memberships: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}

/**
 * Remove user from all project memberships in an organization
 */
export async function removeUserProjectMembershipsInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Removing project memberships for user ${userId} in org ${organizationId}`,
		);

		// Get all projects in this org
		const orgProjects = await db.project.findMany({
			where: { organizationId },
			select: { id: true },
		});

		const projectIds = orgProjects.map((p) => p.id);

		if (projectIds.length === 0) {
			return { deletedCount: 0, errors };
		}

		// Remove project memberships
		const result = await db.projectMember.deleteMany({
			where: {
				userId,
				projectId: { in: projectIds },
			},
		});

		totalDeleted = result.count;

		logger.info(
			`[MemberCascade] Removed ${totalDeleted} project memberships for user ${userId}`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to remove project memberships: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}

/**
 * Delete MCP configs owned by user in an organization
 */
export async function deleteUserMcpConfigsInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId, batchSize = 100 } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Deleting MCP configs for user ${userId} in org ${organizationId}`,
		);

		// Delete MCP configs in batches
		let hasMore = true;
		while (hasMore) {
			const configs = await db.mCPConfig.findMany({
				where: {
					userId,
					organizationId,
				},
				select: { id: true },
				take: batchSize,
			});

			if (configs.length === 0) {
				hasMore = false;
				break;
			}

			const configIds = configs.map((c) => c.id);

			const result = await db.mCPConfig.deleteMany({
				where: {
					id: { in: configIds },
					userId,
					organizationId,
				},
			});

			totalDeleted += result.count;
			logger.info(
				`[MemberCascade] Deleted ${result.count} MCP configs in batch`,
			);
		}

		logger.info(
			`[MemberCascade] Deleted ${totalDeleted} total MCP configs for user ${userId}`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to delete MCP configs: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}

/**
 * Delete agent template instances owned by user in an organization
 */
export async function deleteUserAgentTemplateInstancesInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId, batchSize = 100 } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Deleting agent template instances for user ${userId} in org ${organizationId}`,
		);

		// Delete agent template instances in batches
		let hasMore = true;
		while (hasMore) {
			const instances = await db.agentTemplateInstance.findMany({
				where: {
					userId,
					organizationId,
				},
				select: { id: true },
				take: batchSize,
			});

			if (instances.length === 0) {
				hasMore = false;
				break;
			}

			const instanceIds = instances.map((i) => i.id);

			const result = await db.agentTemplateInstance.deleteMany({
				where: {
					id: { in: instanceIds },
					userId,
					organizationId,
				},
			});

			totalDeleted += result.count;
			logger.info(
				`[MemberCascade] Deleted ${result.count} agent template instances in batch`,
			);
		}

		logger.info(
			`[MemberCascade] Deleted ${totalDeleted} total agent template instances for user ${userId}`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to delete agent template instances: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}

/**
 * Clear `activeOrganizationId` on the removed user's sessions so
 * in-flight requests that read the session directly (raw Next.js
 * route handlers) immediately lose the org context they no longer
 * have a role in.
 */
export async function clearUserOrgSessionsActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ clearedCount: number; errors: string[] }> {
	const { userId, organizationId } = input;
	const errors: string[] = [];
	let clearedCount = 0;

	try {
		logger.info(
			`[MemberCascade] Clearing active-org sessions for user ${userId} (org ${organizationId})`,
		);

		const result = await db.session.updateMany({
			where: {
				userId,
				activeOrganizationId: organizationId,
			},
			data: {
				activeOrganizationId: null,
			},
		});

		clearedCount = result.count;

		logger.info(
			`[MemberCascade] Cleared activeOrganizationId on ${clearedCount} session(s) for user ${userId}`,
		);

		return { clearedCount, errors };
	} catch (error) {
		const errorMsg = `Failed to clear user sessions: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { clearedCount, errors };
	}
}

/**
 * Delete chats owned by user in an organization
 */
export async function deleteUserChatsInOrgActivity(
	input: MemberCascadeDeleteInput,
): Promise<{ deletedCount: number; errors: string[] }> {
	const { userId, organizationId, batchSize = 100 } = input;
	const errors: string[] = [];
	let totalDeleted = 0;

	try {
		logger.info(
			`[MemberCascade] Deleting chats for user ${userId} in org ${organizationId}`,
		);

		// Delete chats in batches
		let hasMore = true;
		while (hasMore) {
			const chats = await db.aiChat.findMany({
				where: {
					userId,
					organizationId,
				},
				select: { id: true },
				take: batchSize,
			});

			if (chats.length === 0) {
				hasMore = false;
				break;
			}

			const chatIds = chats.map((c) => c.id);

			const result = await db.aiChat.deleteMany({
				where: {
					id: { in: chatIds },
					userId,
					organizationId,
				},
			});

			totalDeleted += result.count;
			logger.info(
				`[MemberCascade] Deleted ${result.count} chats in batch`,
			);
		}

		logger.info(
			`[MemberCascade] Deleted ${totalDeleted} total chats for user ${userId}`,
		);

		return { deletedCount: totalDeleted, errors };
	} catch (error) {
		const errorMsg = `Failed to delete chats: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[MemberCascade] ${errorMsg}`);
		errors.push(errorMsg);
		return { deletedCount: totalDeleted, errors };
	}
}
