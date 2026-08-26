import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * Start a Temporal `syncPipelineResultsWorkflow` — the live "pull" that fetches
 * new CI Test Runs (Azure DevOps) for a project, ingests them, and (when the
 * project opted in) opens BUGs for cases left FAILED. Write-gated by
 * TEST_CASE_UPDATE + the pipeline-results feature flag.
 *
 * The workflow id is project-scoped (`pipeline-results-sync-{projectId}`) with a
 * USE_EXISTING conflict policy, so two rapid "Sync now" clicks (or a click during
 * an in-flight sync) collapse onto ONE run instead of racing — which also prevents
 * concurrent RCA passes from double-opening the same bug.
 */
export const syncPipelineResultsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pipeline-results/sync",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Pull new CI/pipeline test results for a project",
		description:
			"Start a Temporal workflow that pulls new Azure DevOps Test Runs into Fabric and, when enabled, opens bugs for failing cases. Requires TEST_CASE_UPDATE.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** Limit to one connected repo integration; omit to sync all ADO sources. */
			integrationId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) is the tenant
		// boundary — only callers with update rights on this project reach here, so
		// no caller-supplied org is trusted.
		const user = context.user;

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				autoCreateBugsFromFailures: true,
			},
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Fail fast with a clear message rather than starting a no-op run when the
		// project has no connected code repo to pull CI results from. Every
		// supported provider (Azure DevOps, GitHub, GitLab) counts.
		const repoCount = await db.projectRepositoryIntegration.count({
			where: {
				projectId: input.projectId,
				provider: { in: ["AZURE_DEVOPS", "GITHUB", "GITLAB"] },
				// Mirrors `getProjectReposForPipelineSync`, which deliberately
				// accepts anything not DISCONNECTED. A repo flipped to ERROR or
				// TOKEN_EXPIRED by a code-INDEXING failure still holds a valid
				// CI-read credential — that was the whole point of #2271, and
				// gating the trigger on ACTIVE re-broke it one layer up, so the
				// button refused to start a sync the activity would have handled.
				status: { not: "DISCONNECTED" },
				...(input.integrationId ? { id: input.integrationId } : {}),
			},
		});
		if (repoCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Connect a code repository (Azure DevOps, GitHub, or GitLab) in Project Settings → Repositories before pulling pipeline results.",
			});
		}

		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();

			const workflowId = `pipeline-results-sync-${input.projectId}`;
			const handle = await client.workflow.start(
				"syncPipelineResultsWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					// Collapse concurrent triggers for one project onto a single run.
					workflowIdReusePolicy: "ALLOW_DUPLICATE" as const,
					workflowIdConflictPolicy: "USE_EXISTING" as const,
					args: [
						{
							projectId: input.projectId,
							organizationId: project.organizationId,
							userId: user.id,
							integrationId: input.integrationId,
							autoCreateBugsFromFailures:
								project.autoCreateBugsFromFailures,
						},
					],
				}),
			);

			return {
				workflowId: handle.workflowId,
				status: "started" as const,
				message: "Pipeline-results sync started",
			};
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: "Failed to start pipeline-results sync";
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					message.includes("UNAVAILABLE") ||
					message.includes("connection") ||
					message.includes("connect")
						? "Sync service is temporarily unavailable. Please try again in a moment."
						: `Failed to start sync: ${message}`,
			});
		}
	});
