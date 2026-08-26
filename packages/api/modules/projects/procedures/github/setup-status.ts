/**
 * Code-Based Setup Status
 *
 * Returns the code analysis status + document generation progress.
 * Polled by the frontend progress banner every ~5 seconds.
 *
 * AUTHORIZATION: Uses hasProjectAccess() — verifies read access
 */

import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const codeBasedSetupStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "GET",
		path: "/projects/:projectId/github/setup-status",
		tags: ["Projects", "GitHub"],
		summary: "Get code-based setup progress status",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId } = input;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify user has access to the project
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Get project status
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				codeAnalysisStatus: true,
				codeAnalysisWorkflowId: true,
				repositoryOwner: true,
				repositoryName: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Get document statuses
		const documents = await db.projectDocument.findMany({
			where: { projectId },
			select: {
				id: true,
				type: true,
				title: true,
				status: true,
				generationProgress: true,
			},
			orderBy: { createdAt: "asc" },
		});

		// Compute overall progress
		const totalDocs = documents.length;
		const completedDocs = documents.filter(
			(d) => d.status === "COMPLETE",
		).length;
		const generatingDocs = documents.filter(
			(d) => d.status === "GENERATING",
		).length;

		let phase: "scanning" | "generating" | "completed" | "failed" | "idle" =
			"idle";
		if (project.codeAnalysisStatus === "SCANNING") {
			phase = generatingDocs > 0 ? "generating" : "scanning";
		} else if (project.codeAnalysisStatus === "COMPLETED") {
			phase = "completed";
		} else if (project.codeAnalysisStatus === "FAILED") {
			phase = "failed";
		}

		return {
			codeAnalysisStatus: project.codeAnalysisStatus,
			workflowId: project.codeAnalysisWorkflowId,
			repo:
				project.repositoryOwner && project.repositoryName
					? `${project.repositoryOwner}/${project.repositoryName}`
					: null,
			phase,
			documents: documents.map((d) => ({
				id: d.id,
				type: d.type,
				title: d.title,
				status: d.status,
				progress: d.generationProgress ?? 0,
			})),
			totalDocuments: totalDocs,
			completedDocuments: completedDocs,
			generatingDocuments: generatingDocs,
		};
	});
