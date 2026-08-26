import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import {
	createWorkflowExecution,
	getWorkflowById,
	type Prisma,
} from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
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

		const { workflowId } = parseResult.data;

		// SECURITY: Use organizationId from session, not from client payload.
		// The client cannot be trusted to provide the correct org context.
		const organizationId =
			session.session?.activeOrganizationId ?? undefined;

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

		// Create execution record
		const execution = await createWorkflowExecution({
			workflowId,
			version: workflow.version,
			triggerType: "MANUAL",
			triggerInput: {
				source: "fabric-ai-chat-confirmed",
			} as Prisma.InputJsonValue,
			userId,
			organizationId,
		});

		// Start Temporal workflow if available
		const temporalAvailable = await isTemporalAvailable();
		let temporalWorkflowId: string | null = null;

		if (temporalAvailable) {
			try {
				const client = await getTemporalClient();
				const handle = await client.workflow.start(
					"workflowBuilderExecutionWorkflow",
					{
						taskQueue: "workflow-builder",
						workflowId: `workflow-execution-${execution.id}`,
						args: [
							{
								executionId: execution.id,
								workflowId,
								userId,
								organizationId,
							},
						],
					},
				);
				temporalWorkflowId = handle.workflowId;
			} catch (error) {
				console.error(
					"[Execute Workflow API] Failed to start Temporal workflow:",
					error,
				);
			}
		}

		return NextResponse.json({
			success: true,
			executionId: execution.id,
			workflowName: workflow.name,
			temporalWorkflowId,
			message: temporalWorkflowId
				? `Workflow "${workflow.name}" has been started. Execution ID: ${execution.id}`
				: `Workflow "${workflow.name}" execution has been queued. Execution ID: ${execution.id}`,
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
