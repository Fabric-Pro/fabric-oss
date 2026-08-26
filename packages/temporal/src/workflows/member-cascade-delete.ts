/**
 * Workflow for cascading deletion when a user is removed from an organization
 *
 * This workflow is triggered when a user is removed from an organization and handles
 * the cleanup of all user-owned entities in that organization to ensure:
 * 1. No orphaned data remains
 * 2. Users cannot access org data after removal
 * 3. Cleanup is durable and retryable
 *
 * The workflow uses Temporal for durability - if it fails partway through,
 * it will resume from where it left off when retried.
 */

import { log, patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

// Configure activities with retry policies
const {
	clearUserOrgSessionsActivity,
	deleteUserProjectsInOrgActivity,
	deleteUserWorkflowsInOrgActivity,
	deleteUserWorkspacesInOrgActivity,
	removeUserWorkspaceMembershipsInOrgActivity,
	removeUserProjectMembershipsInOrgActivity,
	deleteUserMcpConfigsInOrgActivity,
	deleteUserAgentTemplateInstancesInOrgActivity,
	deleteUserChatsInOrgActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		maximumInterval: "1m",
	},
});

// Attachment storage cleanup gets more retries than the default (the project
// rows are already gone, so we want durable transient recovery before giving up).
const { deleteProjectAttachmentsFromStorageActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 10,
		maximumInterval: "2m",
	},
});

// ============================================================================
// Types
// ============================================================================

export interface MemberCascadeDeleteWorkflowInput {
	/** The user being removed from the organization */
	userId: string;
	/** The organization the user is being removed from */
	organizationId: string;
	/** Optional: batch size for deletion operations (default: 100) */
	batchSize?: number;
}

export interface MemberCascadeDeleteWorkflowOutput {
	/** Whether the cascade delete completed successfully */
	success: boolean;
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
	/** Duration of the workflow in milliseconds */
	durationMs: number;
}

// ============================================================================
// Workflow
// ============================================================================

/**
 * Cascade delete workflow for member removal
 *
 * Execution order:
 * 1. Remove memberships first (prevents access immediately)
 * 2. Delete owned entities (projects, workflows, workspaces, etc.)
 *
 * This order ensures that:
 * - User loses access immediately when memberships are removed
 * - Owned entities are cleaned up after access is revoked
 */
export async function memberCascadeDeleteWorkflow(
	input: MemberCascadeDeleteWorkflowInput,
): Promise<MemberCascadeDeleteWorkflowOutput> {
	const startTime = Date.now();
	const { userId, organizationId, batchSize = 100 } = input;

	log.info("Starting member cascade delete workflow", {
		userId,
		organizationId,
		batchSize,
	});

	const errors: string[] = [];
	const deletedCounts = {
		sessionsCleared: 0,
		projects: 0,
		workflows: 0,
		workspaces: 0,
		workspaceMemberships: 0,
		projectMemberships: 0,
		mcpConfigs: 0,
		agentTemplateInstances: 0,
		chats: 0,
	};

	const activityInput = { userId, organizationId, batchSize };

	// Step 0: Clear active-organization sessions FIRST so any in-flight
	// request from the removed user immediately loses the org context.
	// Subsequent deletion steps may race with a held session; clearing
	// the session pointer up front closes that window.
	log.info("Step 0: Clearing active-org sessions");
	const sessionClearResult =
		await clearUserOrgSessionsActivity(activityInput);
	deletedCounts.sessionsCleared = sessionClearResult.clearedCount;
	errors.push(...sessionClearResult.errors);

	// Step 1: Remove memberships first (prevents access immediately)
	// These run in parallel since they're independent
	log.info("Step 1: Removing memberships");

	const [workspaceMembershipResult, projectMembershipResult] =
		await Promise.all([
			removeUserWorkspaceMembershipsInOrgActivity(activityInput),
			removeUserProjectMembershipsInOrgActivity(activityInput),
		]);

	deletedCounts.workspaceMemberships = workspaceMembershipResult.deletedCount;
	errors.push(...workspaceMembershipResult.errors);

	deletedCounts.projectMemberships = projectMembershipResult.deletedCount;
	errors.push(...projectMembershipResult.errors);

	log.info("Step 1 complete: Memberships removed", {
		workspaceMemberships: deletedCounts.workspaceMemberships,
		projectMemberships: deletedCounts.projectMemberships,
	});

	// Step 2: Delete owned entities
	// Run in parallel for efficiency - each handles its own entity type
	log.info("Step 2: Deleting owned entities");

	const [
		projectsResult,
		workflowsResult,
		workspacesResult,
		mcpConfigsResult,
		agentInstancesResult,
		chatsResult,
	] = await Promise.all([
		deleteUserProjectsInOrgActivity(activityInput),
		deleteUserWorkflowsInOrgActivity(activityInput),
		deleteUserWorkspacesInOrgActivity(activityInput),
		deleteUserMcpConfigsInOrgActivity(activityInput),
		deleteUserAgentTemplateInstancesInOrgActivity(activityInput),
		deleteUserChatsInOrgActivity(activityInput),
	]);

	deletedCounts.projects = projectsResult.deletedCount;
	errors.push(...projectsResult.errors);

	deletedCounts.workflows = workflowsResult.deletedCount;
	errors.push(...workflowsResult.errors);

	deletedCounts.workspaces = workspacesResult.deletedCount;
	errors.push(...workspacesResult.errors);

	deletedCounts.mcpConfigs = mcpConfigsResult.deletedCount;
	errors.push(...mcpConfigsResult.errors);

	deletedCounts.agentTemplateInstances = agentInstancesResult.deletedCount;
	errors.push(...agentInstancesResult.errors);

	deletedCounts.chats = chatsResult.deletedCount;
	errors.push(...chatsResult.errors);

	log.info("Step 2 complete: Owned entities deleted", deletedCounts);

	// Step 2b: Best-effort attachment object cleanup for the hard-deleted projects
	// (gated for replay determinism). Their rows are gone, so the FK cascade left
	// story-attachments/{projectId}/ objects orphaned in R2. A cleanup failure must
	// NOT fail the cascade (the DB delete is the source of truth) — it is swallowed
	// and deliberately NOT pushed to `errors`.
	if (patched("attachment-r2-cleanup-on-member-cascade")) {
		for (const projectId of projectsResult.deletedProjectIds) {
			try {
				await deleteProjectAttachmentsFromStorageActivity({
					projectId,
				});
			} catch (err) {
				log.error(
					`Attachment storage cleanup failed after retries for project ${projectId} (objects orphaned)`,
					{ error: err instanceof Error ? err.message : String(err) },
				);
			}
		}
	}

	// Calculate totals
	const totalDeleted = Object.values(deletedCounts).reduce(
		(sum, count) => sum + count,
		0,
	);
	const durationMs = Date.now() - startTime;
	const success = errors.length === 0;

	if (errors.length > 0) {
		log.warn("Member cascade delete completed with errors", {
			userId,
			organizationId,
			totalDeleted,
			errorCount: errors.length,
			errors: errors.slice(0, 5), // Log first 5 errors
			durationMs,
		});
	} else {
		log.info("Member cascade delete completed successfully", {
			userId,
			organizationId,
			totalDeleted,
			durationMs,
		});
	}

	return {
		success,
		totalDeleted,
		deletedCounts,
		errors,
		durationMs,
	};
}
