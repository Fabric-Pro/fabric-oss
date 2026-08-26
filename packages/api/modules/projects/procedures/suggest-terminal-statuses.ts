import { ORPCError } from "@orpc/client";
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { db, hasProjectAccess } from "@repo/database";
import { zodSchema } from "ai";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/** Built-in default used when the project has no list yet or AI is unavailable. */
const DEFAULT_TERMINAL_STATUSES = ["Closed", "Done", "Removed"];

const SUGGESTION_SCHEMA = z.object({
	terminalStatuses: z.array(z.string()),
	reasoning: z.string().optional(),
});

export const suggestTerminalStatusesProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "id",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/{id}/terminal-statuses/suggest",
		tags: ["Projects", "PM Sync"],
		summary: "AI-recommend terminal statuses for the connected PM tool",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.id,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const project = await db.project.findUnique({
			where: { id: input.id },
			select: {
				projectManagementMcpServerId: true,
				organizationId: true,
				userId: true,
			},
		});
		const tool = project?.projectManagementMcpServerId ?? "the PM tool";

		try {
			// Resolve the AI tenant from the PROJECT's owner (matching the
			// background-poll convention), not the requesting user/session.
			const { model, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "SIMPLE" },
				{
					userId: project?.userId ?? user.id,
					organizationId: project?.organizationId ?? undefined,
				},
			);
			const { object } = await generateObject({
				model,
				schema: zodSchema(SUGGESTION_SCHEMA),
				prompt: [
					`A project is connected to the PM tool "${tool}".`,
					"List the work-item statuses for that tool that represent a TERMINAL / completed / closed state",
					"(e.g. Done, Closed, Resolved, Removed, Declined, Duplicate, Not Doing, Completed).",
					"Return only the status names as they appear in that tool, no explanations in the array.",
				].join(" "),
			});
			trackUsage();

			const cleaned = Array.from(
				new Set(
					(object.terminalStatuses ?? [])
						.map((s) => s.trim())
						.filter((s) => s.length > 0),
				),
			);
			if (cleaned.length === 0) {
				return {
					terminalStatuses: DEFAULT_TERMINAL_STATUSES,
					usedFallback: true,
				};
			}
			return { terminalStatuses: cleaned, usedFallback: false };
		} catch {
			return {
				terminalStatuses: DEFAULT_TERMINAL_STATUSES,
				usedFallback: true,
			};
		}
	});
