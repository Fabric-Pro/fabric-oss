/**
 * Start Weave Execution Procedure
 *
 * Starts orchestrated execution of an approved Weave plan.
 * Alternative to approve-plan for deferred execution.
 */

import { ORPCError } from "@orpc/server";
import { createId } from "@paralleldrive/cuid2";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { isUniqueConstraintViolation } from "../../../lib/prisma-unique-violation";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	assertProjectPermission,
	Permissions,
	protectedProcedure,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";
import { assertStoryReadyForRun } from "../../projects/lib/run-readiness";
import { PENDING_RUN_ID } from "../lib/temporal-handle";

/** Partial unique index from plan §F2 (one active Weave execution per story). */
const ACTIVE_EXECUTION_INDEX = "weave_execution_one_active_per_story";

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

/**
 * Temporal rejects a second start for a workflow id whose execution is
 * still open. Because the id is derived from the execution row, hitting
 * this means an earlier attempt for this same row already started the
 * workflow, so the start is confirmed rather than failed. Matched by
 * name: `@temporalio/client` is not a direct dependency of this package.
 */
function isWorkflowAlreadyStartedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/** Temporal's typed "no such execution" error, matched by name as above. */
function isWorkflowNotFoundError(error: unknown): boolean {
	return error instanceof Error && error.name === "WorkflowNotFoundError";
}

type WorkflowStartOutcome =
	| { status: "exists"; runId: string }
	| { status: "not-found" }
	| { status: "unknown"; error: unknown };

/**
 * A start request can fail on the client (timeout, dropped connection)
 * after the server has already accepted it, so a generic start error does
 * not say whether an execution exists. Describing the deterministic
 * workflow id settles it: a description means the workflow exists (and
 * carries the real run id), a typed WorkflowNotFoundError means the start
 * never happened, and any other failure leaves the question open.
 */
async function describeWorkflowStart(
	client: TemporalClient,
	workflowId: string,
): Promise<WorkflowStartOutcome> {
	try {
		const description = await client.workflow
			.getHandle(workflowId)
			.describe();
		return { status: "exists", runId: description.runId };
	} catch (error) {
		if (isWorkflowNotFoundError(error)) {
			return { status: "not-found" };
		}
		return { status: "unknown", error };
	}
}

/**
 * GitHub owner/repo URL forms accepted by the Background Agents sandbox
 * (HTTPS, SSH and scp-style). Replicated from the worker-side sandbox parser
 * rather than imported, because importing the worker's coding-execution
 * module would run its module-load environment validation inside the API
 * process, where the worker-scoped variables legitimately do not exist.
 *
 * The host is compared against the URL's parsed `hostname`. A substring match
 * would also accept a URL whose real host is somewhere else —
 * `https://example.com/github.com/owner/repo`, or
 * `https://github.com@example.com/owner/repo` — and hand it to the sandbox as
 * a GitHub repository.
 */
const GITHUB_HOSTNAMES = new Set(["github.com", "www.github.com"]);

function isGitHubRepoUrl(repoUrl: string): boolean {
	const trimmed = repoUrl.trim();
	const scpStyle = trimmed.match(/^git@([^:]+):(.+)$/i);
	const candidate = scpStyle
		? `https://${scpStyle[1]}/${scpStyle[2]}`
		: /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return false;
	}

	if (!GITHUB_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
		return false;
	}
	// The sandbox parser needs both an owner and a repo segment.
	return parsed.pathname.split("/").filter(Boolean).length >= 2;
}

const StartExecutionInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
	repoUrl: z.string().optional(),
	targetBranch: z.string().optional(),
	executionProvider: z.enum(["BACKGROUND_AGENTS", "KANBAN_LOCAL"]).optional(),
});

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

		// Run-start gate (plan §F1 / Slice 5): execution can happen long
		// after plan creation, so readiness is enforced here, not at
		// create-plan. Throws PRECONDITION_FAILED with `data.missing`.
		if (plan.userStoryId) {
			await assertStoryReadyForRun({
				storyId: plan.userStoryId,
				projectId: plan.projectId,
			});
		}

		// The row id is chosen here so the workflow id is deterministic and
		// derivable from the row: a retried start for the same row maps onto
		// the same Temporal execution instead of launching a second one.
		const executionId = createId();
		const workflowId = `weave-exec-${executionId}`;

		// `userStoryId` is denormalised from the plan so the partial unique
		// index (plan §F2) can guarantee one active execution per story.
		let execution: Awaited<ReturnType<typeof db.weaveExecution.create>>;
		try {
			execution = await db.weaveExecution.create({
				data: {
					id: executionId,
					planId: input.planId,
					projectId: plan.projectId,
					userStoryId: plan.userStoryId ?? null,
					workflowId,
					runId: PENDING_RUN_ID,
					status: "PENDING",
					userId,
					organizationId: organizationId ?? null,
				},
			});
		} catch (error) {
			if (isUniqueConstraintViolation(error, ACTIVE_EXECUTION_INDEX)) {
				throw new ORPCError("CONFLICT", {
					message:
						"A Weave execution is already active for this feature.",
					data: {
						code: "ACTIVE_EXECUTION_EXISTS",
						storyId: plan.userStoryId,
					},
				});
			}
			throw error;
		}

		/** Releases the PENDING row. Only valid while no execution exists. */
		const releasePendingRow = async (error: unknown) => {
			await db.weaveExecution.update({
				where: { id: execution.id },
				data: { status: "FAILED", error: String(error) },
			});
		};

		// Phase A — start the workflow. This is the only place the PENDING
		// row may be released. Once Temporal has accepted the start there is
		// a live execution behind this row; marking it FAILED after that
		// point would drop it out of the one-active-per-story index and let
		// a retry launch a second execution for the same feature.
		//
		// The client is obtained before the start attempt so a failure to
		// build it is known to precede any start request.
		let temporal: TemporalClient;
		try {
			temporal = await getTemporalClient();
		} catch (error) {
			logger.error(
				{ err: error, executionId: execution.id, workflowId },
				"[weave] Failed to connect to Temporal for execution start",
			);
			await releasePendingRow(error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start execution workflow",
			});
		}

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

		let runId: string | undefined;
		try {
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
			runId = handle.firstExecutionRunId;
		} catch (error) {
			if (isWorkflowAlreadyStartedError(error)) {
				logger.info(
					{ executionId: execution.id, workflowId },
					"[weave] Execution workflow already started; treating start as confirmed",
				);
				// The start is confirmed by the typed error; the describe only
				// recovers the real run id so it can replace the placeholder.
				const outcome = await describeWorkflowStart(
					temporal,
					workflowId,
				);
				if (outcome.status === "exists") {
					runId = outcome.runId;
				} else {
					logger.warn(
						{ executionId: execution.id, workflowId, outcome },
						"[weave] Could not resolve run id for already-started workflow; readers will address the workflow id alone",
					);
				}
			} else {
				// The rejection alone does not say whether Temporal accepted
				// the start before the client gave up; ask the server.
				const outcome = await describeWorkflowStart(
					temporal,
					workflowId,
				);

				if (outcome.status === "not-found") {
					logger.error(
						{ err: error, executionId: execution.id, workflowId },
						"[weave] Failed to start execution workflow",
					);
					// Temporal has no execution for this id, so nothing is
					// running for this row: release it so the plan can be
					// retried.
					await releasePendingRow(error);
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: "Failed to start execution workflow",
					});
				}

				if (outcome.status === "unknown") {
					// Neither the start nor the describe reached a verdict. An
					// execution may already be live behind this row, and
					// marking it FAILED would drop it out of the
					// one-active-per-story index and let a retry launch a
					// second execution for the same feature. Leave the row
					// untouched: a stuck PENDING row is recoverable, a
					// duplicate execution is not.
					logger.warn(
						{
							err: error,
							describeErr: outcome.error,
							executionId: execution.id,
							workflowId,
						},
						"[weave] Execution workflow start outcome unknown; leaving row active",
					);
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message:
							"Could not confirm whether the execution workflow started. The execution remains active; retry once Temporal is reachable or cancel it.",
					});
				}

				logger.info(
					{ err: error, executionId: execution.id, workflowId },
					"[weave] Start rejected but the workflow exists; treating start as confirmed",
				);
				runId = outcome.runId;
			}
		}

		// Phase B — bookkeeping for a workflow that is already running. A
		// failure here must not change the row status (see Phase A); the
		// workflow id is already on the row, so log and return the started
		// ids. `runId` is only written when Temporal reported one; otherwise
		// the placeholder stays and readers address the workflow id alone.
		try {
			await db.weaveExecution.update({
				where: { id: execution.id },
				data: {
					...(runId ? { runId } : {}),
					status: "RUNNING",
					startedAt: new Date(),
				},
			});

			await db.weavePlan.update({
				where: { id: input.planId },
				data: { status: "RUNNING" },
			});
		} catch (error) {
			logger.warn(
				{ err: error, executionId: execution.id, workflowId },
				"[weave] Execution workflow started but post-start bookkeeping failed",
			);
		}

		return {
			success: true,
			executionId: execution.id,
			workflowId,
			status: "RUNNING",
		};
	});
