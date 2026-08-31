/**
 * Refine Plan Request Procedure
 *
 * Uses a lightweight LLM call to help users iteratively refine
 * their plan request before submitting to Pattern. The LLM asks
 * clarifying questions and structures the request for better plan quality.
 */

import { ORPCError } from "@orpc/server";
import {
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const RefineRequestInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	/** The current plan request message */
	currentMessage: z.string().min(1),
	/** The user's latest refinement input */
	refinementInput: z.string().min(1),
	/** Previous refinement exchanges for context */
	history: z
		.array(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string(),
			}),
		)
		.default([]),
});

const SYSTEM_PROMPT = `You are helping a user refine a task description for an AI agent team (Fabric Weave).
The team includes: Thread (code analysis), Spindle (external research), Shuttle (implementation), Weft (quality review), and Warp (security audit).

Your job:
1. Ask clarifying questions about scope, constraints, edge cases, and acceptance criteria
2. After each exchange, produce an improved version of the request
3. When the request is clear enough for the agent team to execute well, say so

Be concise and direct. Focus on what the agents need to know:
- What exactly should change or be built?
- Are there specific files, endpoints, or components involved?
- What are the acceptance criteria?
- Are there security or performance constraints?
- Should any existing behavior be preserved?

Respond in this format:
FEEDBACK: <your clarifying question or confirmation>
UPDATED_MESSAGE: <the improved request incorporating all context so far>
READY: <true if the request is clear enough, false if more detail would help>`;

export const refineRequestProcedure = protectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/weave/plans/refine",
		tags: ["Weave"],
		summary: "Refine a plan request with AI assistance",
		description:
			"Uses a lightweight LLM to help structure and clarify a plan request before submitting to Pattern.",
	})
	.input(RefineRequestInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Fetch project context for the LLM
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { name: true, description: true, techStack: true },
		});

		const projectContext = project
			? `Project: ${project.name}${project.techStack?.length ? `\nTech stack: ${project.techStack.join(", ")}` : ""}${project.description ? `\nDescription: ${project.description}` : ""}`
			: "";

		// Build the conversation for the LLM
		const conversationParts: string[] = [];
		if (projectContext) {
			conversationParts.push(
				`<project-context>\n${projectContext}\n</project-context>`,
			);
		}
		conversationParts.push(
			`Current plan request:\n${input.currentMessage}`,
		);

		if (input.history.length > 0) {
			conversationParts.push(
				"\nPrevious refinement exchanges:",
				...input.history.map(
					(h) =>
						`${h.role === "user" ? "User" : "Assistant"}: ${h.content}`,
				),
			);
		}

		conversationParts.push(
			`\nUser's latest input: ${input.refinementInput}`,
		);

		const startTime = Date.now();

		try {
			const { model, metadata, trackUsage } =
				await getAIModelWithMetadata(
					{ taskType: "SIMPLE" },
					{ userId, organizationId: organizationId ?? undefined },
				);

			trackUsage();

			const { text, usage } = await generateText({
				model,
				system: SYSTEM_PROMPT,
				prompt: conversationParts.join("\n\n"),
			});

			logModelUsageAsync({
				context: {
					userId,
					organizationId: organizationId ?? undefined,
				},
				metadata,
				taskType: "SIMPLE",
				usage,
				latencyMs: Date.now() - startTime,
				projectId: input.projectId,
			});

			// Parse the structured response
			const feedbackMatch = text.match(
				/FEEDBACK:\s*([\s\S]*?)(?=\nUPDATED_MESSAGE:|$)/,
			);
			const updatedMessageMatch = text.match(
				/UPDATED_MESSAGE:\s*([\s\S]*?)(?=\nREADY:|$)/,
			);
			const readyMatch = text.match(/READY:\s*(true|false)/i);

			const feedback = feedbackMatch?.[1]?.trim() || text;
			const updatedMessage =
				updatedMessageMatch?.[1]?.trim() || input.currentMessage;
			const isReady = readyMatch?.[1]?.toLowerCase() === "true";

			return {
				success: true,
				feedback,
				updatedMessage,
				isReady,
			};
		} catch (error) {
			console.error("[weave/refine] LLM call failed:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Refinement failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
