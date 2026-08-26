/**
 * Rollback Workflow Procedure
 * Rolls back a workflow to a previous published version
 */

import { ORPCError } from "@orpc/client";
import { db, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { syncWorkflowSchedule } from "../../lib/sync-workflow-schedule";

const rollbackWorkflowInput = z.object({
	workflowId: z.string(),
	targetVersion: z.number(),
});

const rollbackWorkflowOutput = z.object({
	success: z.boolean(),
	version: z.number(),
	message: z.string(),
});

export const rollbackWorkflow = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/{workflowId}/rollback",
		tags: ["Workflows"],
		summary: "Rollback a workflow",
		description: "Roll back a workflow to a previous published version",
	})
	.input(rollbackWorkflowInput)
	.output(rollbackWorkflowOutput)
	.handler(async ({ input, context }) => {
		const { workflowId, targetVersion } = input;
		const userId = context.user.id;

		// Ownership gate. `hasWorkflowAccess` is the same check `get`, `update`
		// and `executions.start` use: a personal workflow is the owner's alone,
		// and an organization workflow additionally requires membership.
		// Membership on its own is NOT sufficient — workflows stay user-owned
		// inside an organization, so a colleague who cannot even read this
		// workflow must not be able to roll it back over its author's edits.
		if (!(await hasWorkflowAccess(workflowId, userId))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		const workflow = await db.workflow.findUnique({
			where: { id: workflowId },
		});

		if (!workflow) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// Find the target version
		const targetVersionData = await db.workflowVersion.findUnique({
			where: {
				workflowId_version: {
					workflowId,
					version: targetVersion,
				},
			},
		});

		if (!targetVersionData) {
			throw new ORPCError("NOT_FOUND", {
				message: `Version ${targetVersion} not found`,
			});
		}

		// Get current max version
		const latestVersion = await db.workflowVersion.findFirst({
			where: { workflowId },
			orderBy: { version: "desc" },
		});

		const newVersion = (latestVersion?.version ?? 0) + 1;

		// Create a new version with the rolled-back content
		await db.workflowVersion.create({
			data: {
				workflowId,
				version: newVersion,
				nodes: targetVersionData.nodes ?? {},
				edges: targetVersionData.edges ?? {},
				variables: targetVersionData.variables ?? undefined,
				settings: targetVersionData.settings ?? undefined,
				triggerConfig: targetVersionData.triggerConfig ?? undefined,
				changelog: `Rollback to version ${targetVersion}`,
				isPublished: true,
				publishedAt: new Date(),
				createdBy: userId,
				// TENANT ISOLATION: child rows carry the parent workflow's
				// tenant, exactly as publish does. `workflow_version` has a
				// `user_owned` RLS policy keyed on these columns, so a row
				// left with both NULL matches neither the organization nor
				// the personal branch — it is invisible to the very version
				// history that is supposed to list it.
				userId: workflow.userId,
				organizationId: workflow.organizationId,
			},
		});

		// Update workflow with rolled-back content
		await db.workflow.update({
			where: { id: workflowId },
			data: {
				nodes: targetVersionData.nodes ?? {},
				edges: targetVersionData.edges ?? {},
				variables: targetVersionData.variables ?? undefined,
				settings: targetVersionData.settings ?? undefined,
				triggerConfig: targetVersionData.triggerConfig ?? undefined,
				version: newVersion,
				publishedVersion: newVersion,
				publishedAt: new Date(),
				publishedBy: userId,
			},
		});

		// Rollback replaces the node graph, and the cron lives on the graph's
		// trigger node — so the schedule that was live a moment ago may no
		// longer match what the workflow now says. Publish and unpublish both
		// sync; without this, rolling back to a different (or absent) cron
		// leaves the previous schedule firing against the new definition.
		// A draft is left alone: its schedule is created when it is published.
		const scheduleActive =
			workflow.status === "PUBLISHED" || workflow.status === "ACTIVE";
		await syncWorkflowSchedule({
			workflowId,
			nodes: targetVersionData.nodes,
			userId: workflow.userId,
			organizationId: workflow.organizationId,
			projectId: workflow.projectId,
			workflowName: workflow.name,
			active: scheduleActive,
		});

		return {
			success: true,
			version: newVersion,
			message: `Workflow rolled back to version ${targetVersion} (now version ${newVersion})`,
		};
	});
