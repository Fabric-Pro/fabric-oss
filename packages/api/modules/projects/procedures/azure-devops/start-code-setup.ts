/**
 * Start Code-Based Project Setup (Azure DevOps)
 *
 * Mirrors `github/start-code-setup.ts` and `gitlab/start-code-setup.ts` for
 * provider parity. Validates the project, issues an AI token, and starts the
 * orchestrator (`existingProjectSetupWorkflow`) to drive `codeAnalysisStatus`.
 *
 * IMPORTANT — orchestrator scan is BEST-EFFORT for Azure DevOps:
 *   The orchestrator's Phase-1 "code analysis" doc-gen step is MCP-coupled.
 *   `findMcpConfigsForRepos` (the activity this workflow calls) ALREADY skips
 *   ADO repos gracefully when no ADO MCP is configured
 *   (`packages/temporal/src/activities/code-based-setup.ts:574-595`), and the
 *   workflow no-ops Phase 1A when no MCP configs resolve. This procedure MUST
 *   NOT add a hard dependency on the ADO MCP.
 *
 *   The canonical source of truth for ADO code context is the clone-based
 *   `codeIndexingWorkflow` (PAT-only, gated by `FEATURE_CODE_INDEXING`), which
 *   is triggered off the `ProjectRepositoryIntegration` / legacy-URL sync that
 *   `repositoryIntegrations.connect` performs — NOT by this procedure. ADO's
 *   `startCodeSetup` exists primarily for parity and to flip
 *   `codeAnalysisStatus` to SCANNING.
 *
 *   `existingProjectSetupWorkflow` is used (not `codeBasedProjectSetupWorkflow`)
 *   because only it routes through the ADO-graceful `findMcpConfigsForRepos`
 *   path; the single-repo `codeBasedProjectSetupWorkflow` supports only
 *   github/gitlab and would hard-fail for ADO.
 *
 * AUTHORIZATION: tenantProtectedProcedure + PROJECT_SETTINGS_EDIT.
 */

import { ORPCError } from "@orpc/client";
import { issueAIToken } from "@repo/ai-token";
import { db, listProjectRepoIntegrations } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import type { ExistingProjectSetupInput } from "@repo/temporal/workflows";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const startAzureDevOpsCodeSetupProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/azure-devops/start-code-setup",
		tags: ["Projects", "Azure DevOps"],
		summary: "Start code-based project setup for Azure DevOps repositories",
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

		// Authorization enforced by `requireProjectPermission` above.

		// Get project
		const project = await db.project.findUnique({
			where: { id: projectId },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Verify project has repository info (connect → syncLegacyProjectRepoOnConnect
		// sets these for the most-recently-connected repo).
		if (!project.repositoryOwner || !project.repositoryName) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Project does not have an Azure DevOps repository configured. Connect a repository first.",
			});
		}

		// Check if analysis is already in progress
		if (project.codeAnalysisStatus === "SCANNING") {
			throw new ORPCError("CONFLICT", {
				message:
					"Code analysis is already in progress for this project",
			});
		}

		// Gather the ACTIVE Azure DevOps repo URLs (multi-repo). These were
		// created by `repositoryIntegrations.connect` at picker-confirm time.
		// listProjectRepoIntegrations never selects encrypted fields.
		type ProjectRepoIntegration = Awaited<
			ReturnType<typeof listProjectRepoIntegrations>
		>[number];
		const integrations = await listProjectRepoIntegrations(projectId);
		const adoRepoUrls = integrations
			.filter(
				(integration: ProjectRepoIntegration) =>
					integration.provider === "AZURE_DEVOPS" &&
					integration.status === "ACTIVE",
			)
			.map(
				(integration: ProjectRepoIntegration) =>
					integration.repositoryUrl,
			);

		// Fall back to the legacy single repositoryUrl if no ADO integration row
		// surfaced a URL (defensive — connect should always have created one).
		const repoUrls =
			adoRepoUrls.length > 0
				? adoRepoUrls
				: project.repositoryUrl
					? [project.repositoryUrl]
					: [];

		// Issue AI token for the workflow
		const aiToken = await issueAIToken({
			userId: user.id,
			organizationId,
			source: "code-based-project-setup",
			expirySeconds: 3600,
		});

		// Start the Temporal workflow. Typed args via ExistingProjectSetupInput
		// (a `type` import — no @temporalio/workflow runtime is pulled in) so the
		// new call is type-checked rather than using `as any`.
		const client = await getTemporalClient();
		const workflowId = `code-based-setup-ado-${projectId}-${Date.now()}`;

		const workflowArgs: ExistingProjectSetupInput = {
			projectId,
			userId: user.id,
			organizationId,
			aiToken,
			repoUrls,
			// No fixed document set here — ADO startCodeSetup primarily drives
			// codeAnalysisStatus; clone-indexing is the source of truth.
			selectedDocumentTypes: [],
			projectTypes: (project.projectTypes as string[]) || [],
			projectName: project.name,
		};

		const handle = await client.workflow.start(
			"existingProjectSetupWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [workflowArgs],
				workflowExecutionTimeout: "45m",
			}),
		);

		return {
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			status: "SCANNING" as const,
		};
	});
