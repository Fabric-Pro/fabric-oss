import { listPromptsForTenant, listSystemPrompts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const browseProcedures = {
	// Requires a session. It was a publicProcedure, and the requirePermission
	// below did nothing to help: that middleware returns next() unconditionally
	// when context.tenantContext is unset, and publicProcedure never sets it —
	// so the gate read as present and was not. Unauthenticated callers were
	// served every system prompt, with content.
	system: tenantProtectedProcedure
		.use(requirePermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts/system",
			tags: ["Prompts"],
			summary: "List system prompts",
		})
		.output(z.any())
		.handler(async () => listSystemPrompts()),

	mine: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.PROMPT_READ))
		.route({
			method: "GET",
			path: "/prompts",
			tags: ["Prompts"],
			summary: "List my prompts",
		})
		.input(
			z
				.object({ organizationId: z.string().nullable().optional() })
				.optional(),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const organizationId = input?.organizationId;
			const user = context.user;
			return listPromptsForTenant({
				userId: organizationId ? undefined : user.id,
				organizationId: organizationId ?? undefined,
			});
		}),
};
