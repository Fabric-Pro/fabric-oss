/**
 * Refine Plan Request Procedure
 *
 * Uses a lightweight LLM call to help users iteratively refine
 * their plan request before submitting to Pattern. The LLM asks
 * clarifying questions and structures the request for better plan quality.
 * The agent runtime's `weave-refine` engine streams the same turn
 * (`../lib/refine-request-turn.ts`, `../lib/refine-response.ts`).
 */

import { ORPCError } from "@orpc/server";
import { generateText } from "@repo/ai";
import { z } from "zod";
import { rethrowChatGptPlanRefusal } from "../../../lib/chatgpt-plan-errors";
import {
	Permissions,
	protectedProcedure,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";
import {
	assertRefineProjectAccess,
	buildRefinePrompt,
	resolveRefineModel,
} from "../lib/refine-request-turn";
import {
	parseRefineResponse,
	REFINE_SYSTEM_PROMPT,
} from "../lib/refine-response";

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

		await assertRefineProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);

		const prompt = await buildRefinePrompt({
			projectId: input.projectId,
			currentMessage: input.currentMessage,
			refinementInput: input.refinementInput,
			history: input.history,
		});

		try {
			const model = await resolveRefineModel({ userId, organizationId });

			const { text } = await generateText({
				model,
				instructions: REFINE_SYSTEM_PROMPT,
				prompt,
			});

			return {
				success: true,
				...parseRefineResponse(text, input.currentMessage),
			};
		} catch (error) {
			rethrowChatGptPlanRefusal(error);
			console.error("[weave/refine] LLM call failed:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Refinement failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
