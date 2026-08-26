/**
 * Weave Chat Procedure
 *
 * Lightweight "Loom chat" endpoint that delegates an ad-hoc question
 * to Thread (codebase) or Spindle (web research) without creating a plan.
 * Returns a streaming-compatible text response.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";
import { assertWeaveServiceHealthy } from "../lib/weave-preflight";

const ChatInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	message: z.string().min(1),
	/** Which agent to route to. Default: thread (codebase exploration). */
	agent: z.enum(["thread", "spindle"]).default("thread"),
});

export const chatProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/weave/chat",
		tags: ["Weave"],
		summary: "Ask a quick question via Loom chat",
		description:
			"Delegates a single question to Thread (codebase) or Spindle (web research) without creating an execution plan.",
	})
	.input(ChatInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
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

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { name: true, description: true, techStack: true },
		});

		// Preflight the readers service so an unconfigured or unreachable
		// target fails fast with a specific error instead of a 60 s timeout.
		const readersUrl = await assertWeaveServiceHealthy({
			envVarName: "WEAVE_READERS_URL",
			localFallback: "http://localhost:8140",
			serviceDescription: "The Weave research service",
		});
		const agentPath = input.agent === "spindle" ? "/spindle" : "/thread";

		try {
			const { SecureA2AClient } = await import("@repo/agent-core");
			const client = new SecureA2AClient({
				timeout: 60_000,
				sourceAgent: "api",
			});

			const result = await client.sendMessageSecure(
				`${readersUrl}${agentPath}`,
				{
					role: "user",
					parts: [{ type: "text", text: input.message }],
					metadata: {
						tenantContext: {
							userId,
							organizationId: organizationId ?? null,
						},
						projectContext: {
							projectId: input.projectId,
							projectName: project?.name || "Unknown",
							description: project?.description || undefined,
							techStack:
								project?.techStack?.join(", ") || undefined,
						},
					},
				},
				{ userId, organizationId: organizationId ?? null },
			);

			const resultObj = result as unknown as Record<string, unknown>;
			const responseText =
				typeof result === "string"
					? result
					: typeof resultObj?.text === "string"
						? resultObj.text
						: JSON.stringify(result);

			return {
				success: true,
				agent: input.agent,
				response: responseText as string,
			};
		} catch (error) {
			console.error("[weave/chat] Agent delegation failed:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `${input.agent} agent unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
