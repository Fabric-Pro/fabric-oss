import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireParlumeProject } from "./sessions";

/** A meeting gets at most ten suggestions an hour, so this covers a long one. */
const SUGGESTIONS_LIMIT = 50;

/**
 * A session's suggestions and recap, newest first: those posted in the meeting
 * chat and those kept for the team. The same readers as the Requests list.
 */
export const listParlumeSuggestionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/suggestions",
		tags: ["Projects", "Parlume"],
		summary: "Review Parlume's suggestions in a meeting",
	})
	.input(z.object({ projectId: z.string(), sessionId: z.string() }))
	.handler(async ({ input }) => {
		const project = await requireParlumeProject(input.projectId);
		const items = await db.parlumeSuggestion.findMany({
			where: {
				projectId: project.id,
				organizationId: project.organizationId,
				sessionId: input.sessionId,
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: SUGGESTIONS_LIMIT,
			select: {
				id: true,
				kind: true,
				audience: true,
				text: true,
				speaker: true,
				quote: true,
				topic: true,
				chatTag: true,
				createdAt: true,
			},
		});
		return { items };
	});
