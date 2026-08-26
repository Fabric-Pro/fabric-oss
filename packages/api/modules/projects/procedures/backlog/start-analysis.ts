import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { backlogAnalysisWorkflowId } from "./workflow-id";

/**
 * Start a backlog context analysis workflow.
 *
 * Triggers the backlogContextAnalysisWorkflow which:
 * 1. Fetches context from selected sources (Teams, meetings, Notion, RAG)
 * 2. Fetches the existing backlog (Fabric DB + PM tool)
 * 3. Runs LLM analysis to propose changes
 *
 * AUTHORIZATION: Uses canEditProject() - verifies org membership + editor role
 */
export const startAnalysisInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	contextSources: z.object({
		fetchTeamsMessages: z.boolean().default(false),
		fetchSlackMessages: z.boolean().default(false),
		selectedMeetings: z
			.array(
				z.object({
					joinUrl: z.string(),
					startTime: z.string().optional(),
				}),
			)
			.optional(),
		selectedChannelContextIds: z.array(z.string()).optional(),
		// Intentionally no default — legacy callers that omit daysBack must continue
		// to get the pre-branch "no time filter" behavior (undefined = fetch all).
		// Only the new selector path passes a concrete value.
		daysBack: z
			.union([
				z.literal(7),
				z.literal(14),
				z.literal(30),
				z.literal(60),
				z.literal(90),
			])
			.optional(),
		notionPageIds: z.array(z.string()).optional(),
		notionMcpConfigId: z.string().optional(),
	}),
	pmConfig: z
		.object({
			mcpConfigId: z.string(),
			containerId: z.string(),
			additionalContext: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
	userPrompt: z.string().min(1),
	/**
	 * Optional `AgentConversation` ID. When the caller
	 * (today: `BacklogChat`) has lazy-created a conversation for the
	 * backlog session, this threads it through to the Temporal workflow
	 * so the completion phase can append a persistent operation-result
	 * `role: "system"` message. Forwarding is unconditional from the
	 * workflow side — the workflow itself short-circuits Step 6 when
	 * absent, preserving today's transient behaviour for any caller
	 * that omits it.
	 */
	conversationId: z.string().max(200).optional(),
});

export const startAnalysisProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/analyze",
		tags: ["Projects", "Backlog"],
		summary: "Start backlog analysis",
		description:
			"Start a Temporal workflow to analyze context and propose backlog changes",
	})
	.input(startAnalysisInputSchema)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get project to confirm existence and get organizationId
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// The analysis runs on THIS project, so its tenant context is the
		// project's own organization — taken from the verified row, never
		// from caller input or the session. An organization named by the
		// caller flows into log-source scoping and MCP config selection
		// downstream, so honouring it would let a project admin scope another
		// organization's data to themselves.
		const organizationId = project.organizationId ?? undefined;

		try {
			const client = await getTemporalClient();

			const workflowId = backlogAnalysisWorkflowId(input.projectId);

			const handle = await client.workflow.start(
				"backlogContextAnalysisWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					args: [
						{
							projectId: input.projectId,
							userId: user.id,
							organizationId,
							contextSources: input.contextSources,
							pmConfig: input.pmConfig,
							userPrompt: input.userPrompt,
							// See input-schema comment above.
							conversationId: input.conversationId,
						},
					],
				}),
			);

			return {
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				message: "Backlog analysis started",
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to start backlog analysis",
			});
		}
	});
