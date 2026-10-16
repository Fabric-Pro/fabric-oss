import { isAgentServiceRequestAuthorized } from "@repo/api/lib/agent-service-auth";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import {
	forbiddenOrganizationResponse,
	resolveRequestedOrganization,
} from "@repo/api/lib/requested-organization";
import {
	WorkflowCommandError,
	type WorkflowCommandErrorCode,
} from "@repo/api/modules/workflows/lib/workflow-command-context";
import { startWorkflowExecutionCommand } from "@repo/api/modules/workflows/lib/workflow-execution-commands";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const executeWorkflowSchema = z.object({
	workflowId: z.string().min(1).max(200),
	organizationId: z.string().max(200).nullish(),
	serviceUserId: z.string().min(1).max(200).optional(),
	projectId: z.string().min(1).max(200).optional(),
});

const REFUSAL_STATUS = {
	NOT_FOUND: 404,
	FORBIDDEN: 403,
	BAD_REQUEST: 400,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
} as const satisfies Record<WorkflowCommandErrorCode, number>;

function refusalResponse(error: WorkflowCommandError) {
	return NextResponse.json(
		{
			error: error.message,
			...(error.code === "TOO_MANY_REQUESTS"
				? { code: "EXECUTION_LIMIT_REACHED" }
				: {}),
		},
		{ status: REFUSAL_STATUS[error.code] },
	);
}

/**
 * Direct Workflow Execution API
 *
 * Starts workflows confirmed in the UI or by an authenticated agent service.
 * Who may start what, the status rule, the graph check, the capacity cap and
 * what each outcome of the engine start means are the start command's
 * (`startWorkflowExecutionCommand`), shared with every other starter. This
 * route authenticates the caller, resolves the organization, and maps the
 * command's answer to a response.
 */
export async function POST(request: NextRequest) {
	try {
		const serviceToken = request.headers.get("X-Agent-Service-Token");
		const serviceRequest = serviceToken !== null;
		const session = serviceRequest ? null : await getSession();
		if (
			serviceRequest
				? !isAgentServiceRequestAuthorized(serviceToken)
				: !session
		) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

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
		const userId = serviceRequest
			? parseResult.data.serviceUserId
			: session?.user.id;
		if (
			!userId ||
			(serviceRequest &&
				(!parseResult.data.organizationId ||
					!parseResult.data.projectId))
		) {
			return NextResponse.json(
				{ error: "A project and actor are required" },
				{ status: 400 },
			);
		}

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
			activeOrganizationId: session?.session?.activeOrganizationId,
		});
		if (!resolution.ok) {
			return forbiddenOrganizationResponse(resolution);
		}
		const { organizationId } = resolution;
		if (!organizationId) {
			return NextResponse.json(
				{
					error: "You do not have permission to run workflows in this organization",
				},
				{ status: 403 },
			);
		}

		const outcome = await startWorkflowExecutionCommand(
			{ userId, organizationId },
			{
				workflowId,
				// One rule for every surface: any published workflow may be
				// started now, whatever its trigger (a scheduled one gets an
				// extra run).
				requirePublished: true,
				source: "fabric-ai-chat-confirmed",
				// An agent service confirms a workflow in the project it is
				// working in, and only that project's.
				confirmedProjectId: serviceRequest
					? parseResult.data.projectId
					: undefined,
			},
		);

		if (outcome.status === "failed") {
			// Nothing picks up a PENDING row later, so a start that did not
			// reach the engine was recorded as a failure and is reported as
			// one, never as a "queued" success.
			return NextResponse.json(
				{
					error: outcome.message,
					code: "EXECUTION_NOT_STARTED",
					executionId: outcome.execution.id,
				},
				{
					status:
						outcome.failure === "engine-unavailable" ? 503 : 502,
				},
			);
		}

		if (outcome.status === "unconfirmed") {
			// 202 Accepted, not a 5xx: a server error reads as "retry", and a
			// retry creates a second row and a second run. The body names the
			// execution so the caller polls it.
			return NextResponse.json(
				{
					success: true,
					status: "unconfirmed",
					executionId: outcome.execution.id,
					workflowName: outcome.workflowName,
					temporalWorkflowId: outcome.temporalWorkflowId,
					message: outcome.message,
				},
				{ status: 202 },
			);
		}

		return NextResponse.json({
			success: true,
			executionId: outcome.execution.id,
			workflowName: outcome.workflowName,
			temporalWorkflowId: outcome.temporalWorkflowId,
			message: `Workflow "${outcome.workflowName}" has been started. Execution ID: ${outcome.execution.id}`,
		});
	} catch (error) {
		if (error instanceof WorkflowCommandError) {
			return refusalResponse(error);
		}
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
