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
import { logWorkflowEvent } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

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
		// implement against.
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
			story.project.applyTddApproach &&
			story.testCaseLinks.length === 0
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"This project works test-first, and this feature has no test cases yet. Add at least one — by hand or with AI — before starting implementation, or turn off “Apply TDD approach” in Settings ▸ Testing.",
				data: { errorCode: "TDD_REQUIRES_TEST_CASES" },
			});
		}

		const selectedTask = taskId
			? (story.tasks.find((task) => task.id === taskId) ?? null)
			: null;

		const executionChannel = "BACKGROUND_AGENTS";
		const provider = "BACKGROUND_AGENTS";

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
				status: {
					in: [
						"QUEUED",
						"STARTING",
						"RUNNING",
						"AWAITING_REVIEW",
						"PR_OPENED",
					],
				},
			},
		});

		if (activeRun) {
			throw new ORPCError("CONFLICT", {
				message:
					"A coding run is already active for this feature. Cancel it first.",
			});
		}

		// Create CodingRun record
		const codingRun = await db.codingRun.create({
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
			},
		});

		try {
			const temporal = await getTemporalClient();
			const workflowId = `coding-run-${codingRun.id}`;
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
						},
					],
				}),
			);

			// Persist workflowId + startedAt so the watchdog can identify
			// stale rows (it scans on `status` non-terminal AND
			// `startedAt < cutoff`).
			await db.codingRun.update({
				where: { id: codingRun.id },
				data: { workflowId, startedAt: new Date() },
			});

			// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
			// (@repo/logs/audit-logger.ts) for v1. Per D5 of
			// docs/audit-log/README.md, AI/MCP/
			// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
			// without coordination — dual-writing is acceptable but a unilateral migration
			// loses the stdout/webhook delivery the operator currently relies on.
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
					source: "coding_runs_start",
				},
			).catch((error) => {
				console.warn(
					"[AuditLog] Failed to log implementation session start:",
					error,
				);
			});

			return {
				codingRunId: codingRun.id,
				workflowId,
				status: "started",
			};
		} catch (error) {
			// Mark the QUEUED row as FAILED so it doesn't block retries
			await db.codingRun
				.update({
					where: { id: codingRun.id },
					data: { status: "FAILED" },
				})
				.catch(() => {});

			if (error instanceof ORPCError) {
				throw error;
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start coding run: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
