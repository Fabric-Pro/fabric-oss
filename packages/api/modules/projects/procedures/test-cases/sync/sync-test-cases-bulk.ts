import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertTestCaseSyncSupported } from "../../../lib/pm-test-case-sync-capability";
import { resolvePmTarget } from "../../../lib/resolve-pm-target";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Start a Temporal `testCaseSyncWorkflow` that pushes Fabric test cases to the
 * configured PM tool (or pulls/imports PM items back). The test-case counterpart
 * of `syncStoriesBulkProcedure`: it resolves the dispatch target with the SAME
 * `resolvePmTarget` (no per-tool fork — MCP and GitLab-REST both work) and starts
 * the workflow on the shared `"ai-chat"` queue. The serializer in the workflow
 * lands steps in the issue body for every tool, with native ADO Steps on top.
 */
export const syncTestCasesBulkProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/sync-bulk",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Start bulk test-case sync workflow",
		description:
			"Start a Temporal workflow to sync test cases to (or from) the configured PM tool. Requires TEST_CASE_UPDATE on the project.",
	})
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				/** Push only: limit to these case ids (else all matching the filter). */
				testCaseIds: z.array(z.string()).optional(),
				unsyncedOnly: z.boolean().optional().default(true),
				direction: z.enum(["push", "pull"]).optional().default("push"),
				/** Pull only: restrict import to these specific PM external IDs. */
				pmExternalIds: z.array(z.string()).optional(),
			})
			.refine(
				(data) =>
					!data.pmExternalIds ||
					!data.pmExternalIds.length ||
					data.direction === "pull",
				{
					message:
						"pmExternalIds can only be used with direction 'pull'",
					path: ["pmExternalIds"],
				},
			),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access — only callers with update rights on this project reach here.
		const user = context.user;

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (!project.projectManagementContainerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select a board in Project Settings to sync test cases with your PM tool.",
			});
		}

		// Resolve the dispatch target for this project + caller. Accepts both
		// MCP-backed projects and the REST-GitLab fallback (gitlab-official
		// server + active WorkflowIntegration, no MCPConfig) — the same resolver
		// the story bulk sync uses, so there is no per-tool fork.
		const target = await resolvePmTarget({
			project: {
				projectManagementMcpServerId:
					project.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					project.projectManagementMcpConfigId,
				organizationId: project.organizationId,
			},
			userId: user.id,
			organizationId: project.organizationId,
		});

		if (!target) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Connect a project management tool in Integrations, then select it in Project Settings → Project Management.",
			});
		}

		// Capability gate (LIVE): only offer the sync a tool can actually perform
		// — push needs work-item create/update, pull needs read. This replaces the
		// old Azure-DevOps-only tier: ANY tool the discovery reports as
		// create/update-capable (Fizzy, GitLab, …) can now push/pull. A non-capable
		// provider gets a clear "not supported" here instead of a workflow that
		// fails deep in the worker. (GitLab-REST targets skip the probe inside.)
		await assertTestCaseSyncSupported(target, input.direction, {
			userId: user.id,
			organizationId: project.organizationId,
		});

		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();

			const additionalContext =
				project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null;

			// A single-case push ("Sync now" + per-case retry) gets a STABLE
			// per-case workflow id + USE_EXISTING conflict policy so two rapid or
			// parallel pushes of the same case de-duplicate onto one run instead of
			// BOTH creating a PM work item (observed live: a concurrent double-push
			// created two Fizzy cards, one orphaned). Mirrors the auto-sync path
			// (enqueue-test-case-auto-sync.ts); a completed run lets the next push
			// start fresh (ALLOW_DUPLICATE). A multi-case batch keeps a per-call id —
			// its case selection isn't a stable dedup key.
			const singleCaseId =
				input.testCaseIds?.length === 1 ? input.testCaseIds[0] : null;
			const workflowId = singleCaseId
				? `test-case-sync-${input.projectId}-${singleCaseId}`
				: `test-case-sync-${input.projectId}-${Date.now()}`;

			// String workflow name to avoid minification issues in production
			// builds. SECURITY: pass the current user's MCP config, not the
			// admin's (mirrors the story bulk sync).
			const handle = await client.workflow.start(
				"testCaseSyncWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					...(singleCaseId
						? {
								workflowIdReusePolicy:
									"ALLOW_DUPLICATE" as const,
								workflowIdConflictPolicy:
									"USE_EXISTING" as const,
							}
						: {}),
					args: [
						{
							projectId: input.projectId,
							// `resolvePmTarget` only returns non-null when the
							// project has a server id (MCP path requires it via
							// resolvePMConfigForUser; REST path checks the server
							// key explicitly).
							// biome-ignore lint/style/noNonNullAssertion: guarded by resolvePmTarget contract above
							mcpServerId: project.projectManagementMcpServerId!,
							mcpConfigId:
								target.kind === "mcp"
									? target.mcpConfigId
									: null,
							containerId: project.projectManagementContainerId,
							containerName:
								project.projectManagementContainerName ??
								undefined,
							additionalContext: additionalContext ?? undefined,
							userId: user.id,
							organizationId: project.organizationId || undefined,
							testCaseIds: input.testCaseIds,
							unsyncedOnly: input.unsyncedOnly,
							direction: input.direction,
							pmExternalIds: input.pmExternalIds,
						},
					],
				}),
			);

			return {
				workflowId: handle.workflowId,
				status: "started",
				message: "Test case sync workflow started",
			};
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: "Failed to start sync workflow";
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
