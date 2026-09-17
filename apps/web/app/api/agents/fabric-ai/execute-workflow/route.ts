import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import {
	forbiddenOrganizationResponse,
	resolveRequestedOrganization,
} from "@repo/api/lib/requested-organization";
import {
	concurrencyRefusalMessage,
	createExecutionWithinConcurrencyCap,
} from "@repo/api/modules/workflows/lib/execution-concurrency";
import {
	attemptWorkflowBuilderStart,
	startFailureMessage,
	unconfirmedStartMessage,
} from "@repo/api/modules/workflows/lib/start-builder-execution";
import {
	canRunOrganizationWorkflows,
	getWorkflowById,
	markExecutionRunningIfPending,
	type Prisma,
	updateWorkflowExecution,
} from "@repo/database";
import { isTemporalAvailable } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const executeWorkflowSchema = z.object({
	workflowId: z.string().min(1).max(200),
	organizationId: z.string().max(200).nullish(),
});

/**
 * Direct Workflow Execution API
 *
 * This endpoint is called directly by the frontend after user confirms
 * workflow execution via the Accept button. It bypasses the AI entirely.
 */
export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const userId = session.user.id;

		// Rate limit: 30 workflow executions per minute per user
		const rateLimitResult = await checkRateLimit(
			`workflow-exec:${userId}`,
			RATE_LIMIT_PRESETS.workflow.limit,
			RATE_LIMIT_PRESETS.workflow.windowMs,
		);
		if (!rateLimitResult.allowed) {
			return NextResponse.json(
				{
					error: "Too many requests",
					message: `Rate limit exceeded. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
				},
				{ status: 429 },
			);
		}

		// Validate request body
		const rawBody = await request.json();
		const parseResult = executeWorkflowSchema.safeParse(rawBody);
		if (!parseResult.success) {
			return NextResponse.json(
				{
					error: "Invalid request body",
					details: parseResult.error.issues,
				},
				{ status: 400 },
			);
		}

		const { workflowId, organizationId: requestedOrganizationId } =
			parseResult.data;

		// The chat tab says which organization it is bound to. Honour it only
		// if the caller has a tie to that organization (membership or an
		// accepted project-guest invitation); without a value the session's
		// active organization is used, verified with the same tie check so a
		// stale active organization the caller has since left is refused
		// rather than served; neither → 403. Never substitute another tenant:
		// a user with two organizations open in two tabs must confirm the
		// workflow in the tab's own tenant, not whichever the session last
		// switched to (ADR-018: no personal/null arm).
		const resolution = await resolveRequestedOrganization({
			userId,
			requestedOrganizationId,
			activeOrganizationId: session.session?.activeOrganizationId,
		});
		if (!resolution.ok) {
			return forbiddenOrganizationResponse(resolution);
		}
		const organizationId = resolution.organizationId;

		// The in-app start requires WORKSPACE_UPDATE, and this route starts
		// the same externally mutating runs, so it asks the same question —
		// live, as of now: a creator demoted since the workflow was built can
		// still see it, but must not run it. There is no personal arm
		// (ADR-018), so a session without an organization is refused too.
		if (
			!organizationId ||
			!(await canRunOrganizationWorkflows(userId, organizationId))
		) {
			return NextResponse.json(
				{
					error: "Forbidden",
					message:
						"You do not have permission to run workflows in this organization",
				},
				{ status: 403 },
			);
		}

		// Get the workflow
		const workflow = await getWorkflowById(
			workflowId,
			userId,
			organizationId,
		);
		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found or you don't have access to it." },
				{ status: 404 },
			);
		}

		// Validate workflow can be executed
		if (workflow.triggerType !== "MANUAL") {
			return NextResponse.json(
				{
					error: `Cannot execute workflow. Trigger type is "${workflow.triggerType}" - only MANUAL workflows can be executed.`,
				},
				{ status: 400 },
			);
		}

		if (workflow.status !== "ACTIVE" && workflow.status !== "PUBLISHED") {
			return NextResponse.json(
				{
					error: `Cannot execute workflow. Status is "${workflow.status}" - only ACTIVE or PUBLISHED workflows can be executed.`,
				},
				{ status: 400 },
			);
		}

		// Same cap every other starter applies. The row is created inside the
		// reservation, so the cap holds under concurrent starts rather than
		// only when nobody races for it.
		const reservation = await createExecutionWithinConcurrencyCap({
			userId,
			organizationId: organizationId ?? null,
			data: {
				workflowId,
				version: workflow.version,
				triggerType: "MANUAL",
				triggerInput: {
					source: "fabric-ai-chat-confirmed",
				} as Prisma.InputJsonValue,
			},
		});
		if (!reservation.allowed) {
			return NextResponse.json(
				{
					error: concurrencyRefusalMessage(reservation),
					code: "EXECUTION_LIMIT_REACHED",
				},
				{ status: 429 },
			);
		}
		const execution = reservation.execution;

		// Nothing picks up a PENDING row later, so a start that Temporal
		// confirms did not reach the engine is a failure: recorded as one and
		// reported as one, never a "queued" success.
		const failStart = async (reason: string, status: number) => {
			await updateWorkflowExecution(execution.id, {
				status: "FAILED",
				error: reason,
				completedAt: new Date(),
			});
			return NextResponse.json(
				{
					error: reason,
					code: "EXECUTION_NOT_STARTED",
					executionId: execution.id,
				},
				{ status },
			);
		};

		if (!(await isTemporalAvailable())) {
			return failStart(
				"The workflow engine is unavailable; the run was not started.",
				503,
			);
		}

		const outcome = await attemptWorkflowBuilderStart({
			executionId: execution.id,
			workflowId,
			userId,
			organizationId,
			projectId: workflow.projectId ?? undefined,
		});

		if (outcome.status === "not-started") {
			console.error(
				"[Execute Workflow API] Failed to start Temporal workflow:",
				outcome.error,
			);
			return failStart(
				`The workflow engine rejected the start: ${startFailureMessage(outcome.error)}`,
				502,
			);
		}

		if (outcome.status === "unknown") {
			// The start call failed and the follow-up describe could not
			// settle whether Temporal accepted it. The run may be in progress
			// under the deterministic id, so the row stays active: failing it
			// would invite a retry, which creates a new row and a second run
			// with the same side effects.
			console.warn(
				"[Execute Workflow API] Start unconfirmed; leaving the execution row active:",
				{ executionId: execution.id, workflowId: outcome.workflowId },
				outcome.error,
			);
			// 202 Accepted, not a 5xx: a server error reads as "retry", and
			// a retry creates a second row and a second run. The body names
			// the execution so the caller polls it.
			return NextResponse.json(
				{
					success: true,
					status: "unconfirmed",
					executionId: execution.id,
					workflowName: workflow.name,
					temporalWorkflowId: outcome.workflowId,
					message: unconfirmedStartMessage(execution.id),
				},
				{ status: 202 },
			);
		}

		const temporalWorkflowId = outcome.workflowId;

		// The run exists in the engine from here on. A failure to persist
		// that fact must not be reported as "not started" (a retry would start
		// a second run with the same side effects), so it is logged and the
		// start is still reported. `temporalRunId` holds the workflow id, the
		// same value every other starter stores and the cancel path reads.
		// PENDING → RUNNING only: a fast run may already have written its
		// terminal status, which must not move back to RUNNING.
		try {
			await markExecutionRunningIfPending({
				executionId: execution.id,
				temporalRunId: temporalWorkflowId,
			});
		} catch (error) {
			console.error(
				"[Execute Workflow API] Workflow started but the execution row could not be marked RUNNING:",
				{ executionId: execution.id, temporalWorkflowId },
				error,
			);
		}

		return NextResponse.json({
			success: true,
			executionId: execution.id,
			workflowName: workflow.name,
			temporalWorkflowId,
			message: `Workflow "${workflow.name}" has been started. Execution ID: ${execution.id}`,
		});
	} catch (error) {
		console.error("[Execute Workflow API] Error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Execution failed",
			},
			{ status: 500 },
		);
	}
}
