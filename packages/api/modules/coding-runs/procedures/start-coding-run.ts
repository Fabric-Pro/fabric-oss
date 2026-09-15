/**
 * Start Coding Run Procedure
 *
 * AUTHORIZATION: Uses canEditProject() - verifies org membership + editor role
 *
 * Starts an implementation session for a feature (UserStory).
 * Creates a CodingRun-backed record and starts a Temporal codingRunWorkflow
 * that dispatches the work to the selected execution provider.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { logger, logWorkflowEvent } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import { isUniqueConstraintViolation } from "../../../lib/prisma-unique-violation";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertStoryReadyForRun } from "../../projects/lib/run-readiness";
import { defaultSpikeQuestion } from "../lib/spike-question";
import { codingRunWorkflowId } from "../lib/workflow-id";

/** Partial unique index from plan §F2 (one active coding run per story). */
const ACTIVE_RUN_INDEX = "coding_run_one_active_per_story";
const ACTIVE_RUN_CONFLICT_MESSAGE =
	"A coding run is already active for this feature.";
const SPIKE_AWAITING_DECISION_MESSAGE =
	"A spike for this feature is awaiting a decision. Accept or discard it first.";

/** Statuses covered by the §F2 partial index (includes DEMO_READY). */
const ACTIVE_RUN_STATUSES = [
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
	"DEMO_READY",
] as const;

/**
 * Plan §F4: a provider may only run spikes when it has proven it can push
 * `fabric-spike/<runId>` without a PR. Read from the adapter definition so
 * no adapter is constructed in the API process (the background adapter's
 * constructor requires worker-only env). Dynamic import keeps Temporal
 * worker code out of the API bundle, as in `pollLiveStatus`.
 */
async function providerCanRunSpikes(
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
): Promise<boolean> {
	const { getCodingExecutionAdapterDefinition, getProviderCapabilities } =
		await import("@repo/temporal/coding-execution");
	return getProviderCapabilities(
		getCodingExecutionAdapterDefinition(provider),
	).pushBranchWithoutPr;
}

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

/**
 * Temporal rejects a second start for a workflow id whose execution is
 * still open. Because the id is derived from the run row, hitting this
 * means an earlier attempt for this same row already started the
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
 * workflow id settles it: a description means the workflow exists, a typed
 * WorkflowNotFoundError means the start never happened, and any other
 * failure leaves the question open.
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

function toStartError(error: unknown): ORPCError<string, unknown> {
	if (error instanceof ORPCError) {
		return error;
	}
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: `Failed to start coding run: ${error instanceof Error ? error.message : "Unknown error"}`,
	});
}

export const startCodingRunProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/coding-runs/start",
		tags: ["CodingRuns"],
		summary: "Start an implementation session for a feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
			executionChannel: z.enum(["BACKGROUND_AGENTS"]).optional(),
			provider: z.enum(["BACKGROUND_AGENTS"]).optional(),
			/**
			 * Run kind (plan §1.3). SPIKE (Slice 3) requires the story to be on
			 * the SPIKE track and the provider to hold the §F4 capability; it
			 * does not require PUBLISHED/readiness — the spike is how the item
			 * becomes ready.
			 */
			kind: z.enum(["IMPLEMENT", "SPIKE"]).default("IMPLEMENT"),
			/** SPIKE only. Defaults to the story title + description summary. */
			spikeQuestion: z.string().min(10).max(2000).optional(),
		}),
	)
	.output(
		z.object({
			codingRunId: z.string(),
			workflowId: z.string(),
			status: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId, storyId, taskId } = input;
		const kind = input.kind ?? "IMPLEMENT";

		// Fetch story with project context
		const story = await db.userStory.findFirst({
			where: { id: storyId, projectId },
			include: {
				tasks: {
					where: { isCompleted: false },
					orderBy: { order: "asc" },
					select: {
						id: true,
						title: true,
						identifier: true,
						description: true,
						repositoryUrl: true,
						repositoryOwner: true,
						repositoryName: true,
						targetBranch: true,
					},
				},
				project: {
					select: {
						name: true,
						organizationId: true,
						repositoryUrl: true,
						repositoryOwner: true,
						repositoryName: true,
						defaultBranch: true,
						readOnlyMode: true,
						applyTddApproach: true,
					},
				},
				// Only whether ANY live case is linked, not the cases themselves:
				// the gate below asks a yes/no question, and a full fetch would
				// load a whole suite to answer it. Soft-deleted cases are
				// excluded — a link outlives the case it points at, and a
				// deleted case is not coverage.
				testCaseLinks: {
					where: { testCase: { deletedAt: null } },
					select: { id: true },
					take: 1,
				},
			},
		});

		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found",
			});
		}

		// Read-only mode: a coding run ends in a branch + PR on
		// the project's connected repository — an external write. Block the
		// start with the same typed error the PM-sync push uses (product
		// decision 2026-07-23: code repos ARE in read-only scope).
		if (story.project.readOnlyMode) {
			throw new ORPCError("CONFLICT", {
				message: READ_ONLY_MODE_MESSAGE,
				data: { errorCode: READ_ONLY_MODE_ERROR_CODE },
			});
		}

		// Test-first projects: no implementation before there is something to
		// implement against. Spikes are exempt: a spike is exploration that
		// produces the evidence the feature is written against, not the
		// implementation itself.
		//
		// This is the only place Fabric can actually hold the line, because it
		// is the only implementation it starts — somebody writing code in their
		// own editor is not gated by anything, which is why the feature's QA
		// panel says "no test cases yet" rather than relying on this alone.
		//
		// Deliberately checks that a case EXISTS, not that one passes. Nothing
		// can pass before the code is written, so a stricter gate would make
		// test-first projects unable to start any work at all. Equally it does
		// not care where the case came from: a hand-written one counts, which
		// keeps this consistent with the ruling that the generation switch gates
		// AI DRAFTING rather than authorship.
		//
		// Off by default. A project that never turns test-first on never sees
		// this.
		if (
			kind !== "SPIKE" &&
			story.project.applyTddApproach &&
			story.testCaseLinks.length === 0
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"This project works test-first, and this feature has no test cases yet. Add at least one — by hand or with AI — before starting implementation, or turn off “Apply TDD approach” in Settings ▸ Testing.",
				data: { errorCode: "TDD_REQUIRES_TEST_CASES" },
			});
		}

		const executionChannel = "BACKGROUND_AGENTS";
		const provider = "BACKGROUND_AGENTS";

		let spikeQuestion: string | undefined;
		if (kind === "SPIKE") {
			// Spike gates (plan Slice 3): track must be SPIKE and the provider
			// must hold the §F4 capability. No PUBLISHED/readiness gate: the
			// spike produces the evidence that makes the item ready.
			if (story.deliveryTrack !== "SPIKE") {
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"Spikes can only run for features on the SPIKE delivery track.",
					data: {
						code: "TRACK_NOT_SPIKE",
						deliveryTrack: story.deliveryTrack,
					},
				});
			}
			if (!(await providerCanRunSpikes(provider))) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: "This execution provider cannot run spikes",
					data: { code: "PROVIDER_CANNOT_SPIKE", provider },
				});
			}
			spikeQuestion =
				input.spikeQuestion?.trim() || defaultSpikeQuestion(story);
		} else {
			// Run-start gate (plan §F1 / Slice 5): the feature must be
			// PUBLISHED and pass readiness for its delivery track. Re-checked
			// here because evidence can change after publish. Throws
			// PRECONDITION_FAILED with `data.missing` for the UI.
			await assertStoryReadyForRun({ storyId, projectId });
		}

		const selectedTask = taskId
			? (story.tasks.find((task) => task.id === taskId) ?? null)
			: null;

		// Validate repository context exists
		const repoUrl =
			selectedTask?.repositoryUrl || story.project.repositoryUrl;
		const repoOwner =
			selectedTask?.repositoryOwner || story.project.repositoryOwner;
		const repoName =
			selectedTask?.repositoryName || story.project.repositoryName;
		const targetBranch =
			selectedTask?.targetBranch || story.project.defaultBranch || "main";
		if (!repoOwner || !repoName) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Configure a repository on the project or selected task before starting an implementation session.",
			});
		}

		// Project is the source of truth for tenant scope — don't fall back
		// to session org, as that would mis-scope a personal project run.
		const workflowOrgId = story.project.organizationId || undefined;
		const organization = workflowOrgId
			? await db.organization.findUnique({
					where: { id: workflowOrgId },
					select: { name: true },
				})
			: null;

		// Check for active coding run on this story (tenant-scoped)
		const activeRun = await db.codingRun.findFirst({
			where: {
				storyId,
				...(workflowOrgId
					? { organizationId: workflowOrgId }
					: { organizationId: null }),
				status: { in: [...ACTIVE_RUN_STATUSES] },
			},
		});

		if (activeRun) {
			const awaitingDecision = activeRun.status === "DEMO_READY";
			throw new ORPCError("CONFLICT", {
				message: awaitingDecision
					? SPIKE_AWAITING_DECISION_MESSAGE
					: `${ACTIVE_RUN_CONFLICT_MESSAGE} Cancel it first.`,
				data: {
					code: awaitingDecision
						? "SPIKE_AWAITING_DECISION"
						: "ACTIVE_RUN_EXISTS",
					storyId,
					activeRunId: activeRun.id,
				},
			});
		}

		// Create CodingRun record. The pre-check above is racy on its own;
		// the partial unique index (plan §F2) is the real guard — a P2002
		// here means a concurrent start won.
		let codingRun: Awaited<ReturnType<typeof db.codingRun.create>>;
		try {
			codingRun = await db.codingRun.create({
				data: {
					projectId,
					storyId,
					storyTaskId: taskId,
					userId: user.id,
					organizationId: workflowOrgId,
					executionChannel,
					provider,
					repositoryUrl: repoUrl,
					repositoryOwner: repoOwner,
					repositoryName: repoName,
					targetBranch: targetBranch,
					status: "QUEUED",
					kind,
					spikeQuestion,
				},
			});
		} catch (error) {
			if (isUniqueConstraintViolation(error, ACTIVE_RUN_INDEX)) {
				throw new ORPCError("CONFLICT", {
					message: `${ACTIVE_RUN_CONFLICT_MESSAGE} If a spike is awaiting a decision, accept or discard it first.`,
					data: { code: "ACTIVE_RUN_EXISTS", storyId },
				});
			}
			throw error;
		}

		// Deterministic: derivable from the row even if persisting it below
		// fails, and a retried start for the same row maps onto the same
		// Temporal execution instead of a second one.
		const workflowId = codingRunWorkflowId(codingRun.id);

		/** Releases the QUEUED row. Only valid while no execution exists. */
		const releaseQueuedRow = async () => {
			await db.codingRun
				.update({
					where: { id: codingRun.id },
					data: { status: "FAILED" },
				})
				.catch(() => {});
		};

		// Phase A — start the workflow. This is the only place the QUEUED row
		// may be released. Once Temporal has accepted the start there is a
		// live execution behind this row; marking it FAILED after that point
		// would drop it out of the one-active-per-story index and let a retry
		// launch a second execution for the same feature.
		//
		// The client is obtained before the start attempt so a failure to
		// build it is known to precede any start request.
		let temporal: TemporalClient;
		try {
			temporal = await getTemporalClient();
		} catch (error) {
			await releaseQueuedRow();
			throw toStartError(error);
		}

		// Hard ceiling — env-overridable. Bounds the worst-case
		// runaway-coding-run leak; the every-5-minute watchdog cron
		// catches rows once Temporal terminates the workflow.
		const maxRunMinutesRaw = Number.parseInt(
			process.env.CODING_RUN_MAX_MINUTES ?? "120",
			10,
		);
		const maxRunMinutes =
			Number.isFinite(maxRunMinutesRaw) && maxRunMinutesRaw > 0
				? maxRunMinutesRaw
				: 120;

		try {
			await temporal.workflow.start(
				"codingRunWorkflow",
				withCorrelationMemo({
					taskQueue: "agents",
					workflowId,
					workflowExecutionTimeout: `${maxRunMinutes}m`,
					args: [
						{
							codingRunId: codingRun.id,
							projectId,
							storyId,
							storyTaskId: taskId,
							userId: user.id,
							organizationId: workflowOrgId,
							provider,
							projectName: story.project.name,
							organizationName: organization?.name ?? undefined,
							repositoryOwner: repoOwner,
							repositoryName: repoName,
							targetBranch: targetBranch,
							storyTitle: `${story.identifier} - ${story.title}`,
							kind,
							spikeQuestion,
						},
					],
				}),
			);
		} catch (error) {
			if (isWorkflowAlreadyStartedError(error)) {
				logger.info(
					{ codingRunId: codingRun.id, workflowId },
					"[CodingRun] Workflow already started; treating start as confirmed",
				);
			} else {
				// The rejection alone does not say whether Temporal accepted
				// the start before the client gave up; ask the server.
				const outcome = await describeWorkflowStart(
					temporal,
					workflowId,
				);

				if (outcome.status === "not-found") {
					// Temporal has no execution for this id, so nothing is
					// running for this row: release it so the feature can be
					// retried.
					await releaseQueuedRow();
					throw toStartError(error);
				}

				if (outcome.status === "unknown") {
					// Neither the start nor the describe reached a verdict. An
					// execution may already be live behind this row, and
					// marking it FAILED would drop it out of the
					// one-active-per-story index and let a retry launch a
					// second execution for the same feature. Leave the row
					// active: a stuck QUEUED row can be cancelled (cancel
					// signals the deterministic id and only then releases),
					// whereas a duplicate execution cannot be undone.
					logger.warn(
						{
							err: error,
							describeErr: outcome.error,
							codingRunId: codingRun.id,
							workflowId,
						},
						"[CodingRun] Workflow start outcome unknown; leaving row active",
					);
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: `Could not confirm whether the coding run workflow started (${error instanceof Error ? error.message : "Unknown error"}). The run remains active; retry once Temporal is reachable or cancel it.`,
					});
				}

				logger.info(
					{ err: error, codingRunId: codingRun.id, workflowId },
					"[CodingRun] Start rejected but the workflow exists; treating start as confirmed",
				);
			}
		}

		// Phase B — bookkeeping for a workflow that is already running. A
		// failure here must not change the row status (see Phase A); the
		// workflow id stays derivable from the row id, so log and return the
		// started ids.
		try {
			// Persist workflowId + startedAt so the watchdog can identify
			// stale rows (it scans on `status` non-terminal AND
			// `startedAt < cutoff`).
			await db.codingRun.update({
				where: { id: codingRun.id },
				data: { workflowId, startedAt: new Date() },
			});

			await logWorkflowEvent(
				"AGENT_TRIGGERED",
				workflowId,
				user.id,
				true,
				{
					organizationId: workflowOrgId,
					projectId,
					storyId,
					storyTaskId: taskId,
					codingRunId: codingRun.id,
					provider,
					executionChannel,
					kind,
					source: "coding_runs_start",
				},
			).catch((error) => {
				logger.warn(
					{ err: error, codingRunId: codingRun.id, workflowId },
					"[AuditLog] Failed to log implementation session start",
				);
			});
		} catch (error) {
			logger.warn(
				{ err: error, codingRunId: codingRun.id, workflowId },
				"[CodingRun] Workflow started but post-start bookkeeping failed",
			);
		}

		return {
			codingRunId: codingRun.id,
			workflowId,
			status: "started",
		};
	});
