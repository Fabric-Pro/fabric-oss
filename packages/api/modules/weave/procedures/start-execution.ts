/**
 * Start Weave Execution Procedure
 *
 * Starts orchestrated execution of an approved Weave plan.
 * Alternative to approve-plan for deferred execution.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	assertProjectPermission,
	Permissions,
	protectedProcedure,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const StartExecutionInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
	repoUrl: z.string().optional(),
	targetBranch: z.string().optional(),
	executionProvider: z.enum(["BACKGROUND_AGENTS", "KANBAN_LOCAL"]).optional(),
});

/**
 * GitHub owner/repo URL patterns accepted by the Background Agents sandbox
 * (HTTPS and SSH forms). Replicated from the worker-side sandbox parser
 * rather than imported, because importing the worker's coding-execution
 * module would run its module-load environment validation inside the API
 * process, where the worker-scoped variables legitimately do not exist.
 */
const GITHUB_HTTPS_REPO_PATTERN =
	/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)/;
const GITHUB_SSH_REPO_PATTERN = /git@github\.com:([^/]+)\/([^/.]+)/;

function isGitHubRepoUrl(repoUrl: string): boolean {
	return (
		GITHUB_HTTPS_REPO_PATTERN.test(repoUrl) ||
		GITHUB_SSH_REPO_PATTERN.test(repoUrl)
	);
}

export const startExecutionProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/executions/start",
		tags: ["Weave"],
		summary: "Start orchestrated plan execution",
		description:
			"Starts orchestration for an approved Weave plan and hands implementation work to the configured execution path when needed.",
	})
	.input(StartExecutionInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const plan = await db.weavePlan.findFirst({
			where: {
				id: input.planId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Plan not found or access denied",
			});
		}

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names a plan, so
		// the project is only known here.
		await assertProjectPermission(
			plan.projectId,
			userId,
			Permissions.AGENT_EXECUTE,
		);

		if (plan.status !== "APPROVED") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Plan must be approved before execution",
			});
		}

		// Preflight: validate provider prerequisites before any execution
		// row or workflow exists, so a misconfigured target fails fast with
		// nothing to clean up. Worker-scoped configuration (the Background
		// Agents control plane) is intentionally not probed here — it is not
		// observable from this process; the workflow validates it seconds
		// after start and persists the failure.
		const executionProvider =
			input.executionProvider ?? "BACKGROUND_AGENTS";

		// The workflow resolves the repository from project metadata, so the
		// project-level URL is the prerequisite for both providers.
		const project = await db.project.findUnique({
			where: { id: plan.projectId },
			select: { repositoryUrl: true },
		});
		const repositoryUrl = project?.repositoryUrl?.trim();

		if (!repositoryUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This project has no repository URL configured. Add one in project settings before delegating work.",
			});
		}

		if (
			executionProvider === "BACKGROUND_AGENTS" &&
			!isGitHubRepoUrl(repositoryUrl)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Background Agents need a GitHub repository URL (https://github.com/owner/repo). Update the project repository URL.",
			});
		}

		if (
			executionProvider === "KANBAN_LOCAL" &&
			!process.env.AGENT_SERVICE_SECRET
		) {
			// The local-delegation bridge authenticates with this secret in
			// every environment, so its absence means delegation cannot work.
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Local delegation is not configured for this environment — set AGENT_SERVICE_SECRET.",
			});
		}

		const workflowId = `weave-exec-${input.planId}-${Date.now()}`;

		const execution = await db.weaveExecution.create({
			data: {
				planId: input.planId,
				projectId: plan.projectId,
				workflowId,
				runId: "pending",
				status: "PENDING",
				userId,
				organizationId: organizationId ?? null,
			},
		});

		try {
			const temporal = await getTemporalClient();
			// Hard ceiling so a workflow that wedges (control-plane hang,
			// runaway iterative loop, dropped agent connection) can't run
			// forever. The watchdog cron is the safety net that catches
			// rows once Temporal terminates the workflow at this timeout.
			const maxRunMinutesRaw = Number.parseInt(
				process.env.WEAVE_MAX_RUN_MINUTES ?? "120",
				10,
			);
			const maxRunMinutes =
				Number.isFinite(maxRunMinutesRaw) && maxRunMinutesRaw > 0
					? maxRunMinutesRaw
					: 120;
			const handle = await temporal.workflow.start(
				"orchestratorExecutionWorkflow",
				withCorrelationMemo({
					workflowId,
					taskQueue: "fabric-orchestrator",
					workflowExecutionTimeout: `${maxRunMinutes}m`,
					args: [
						{
							executionId: workflowId,
							message: `Execute weave plan: ${plan.name}`,
							history: [],
							userId,
							organizationId,
							executionMode: "weave",
							projectId: plan.projectId,
							weavePlanId: input.planId,
							weaveExecutionId: execution.id,
							weaveImplementationProvider:
								input.executionProvider,
						},
					],
				}),
			);

			await db.weaveExecution.update({
				where: { id: execution.id },
				data: {
					runId: handle.firstExecutionRunId,
					status: "RUNNING",
					startedAt: new Date(),
				},
			});

			await db.weavePlan.update({
				where: { id: input.planId },
				data: { status: "RUNNING" },
			});
		} catch (error) {
			console.error("[weave] Failed to start execution:", error);
			await db.weaveExecution.update({
				where: { id: execution.id },
				data: { status: "FAILED", error: String(error) },
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start execution workflow",
			});
		}

		return {
			success: true,
			executionId: execution.id,
			workflowId,
			status: "RUNNING",
		};
	});
