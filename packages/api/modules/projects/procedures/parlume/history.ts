import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireParlumeProject } from "./sessions";

export const listParlumeHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/history",
		tags: ["Projects", "Parlume"],
		summary: "Review Parlume requests, approvals and outcomes",
	})
	.input(
		z.object({
			projectId: z.string(),
			sessionId: z.string().optional(),
			before: z
				.object({ id: z.string(), createdAt: z.coerce.date() })
				.optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await requireParlumeProject(input.projectId);
		const scope = {
			projectId: project.id,
			organizationId: project.organizationId,
		};
		// All of the project's requests, whatever session is being viewed, for
		// the page's tab summary; later pages do not repeat the count.
		const [turns, total] = await Promise.all([
			db.parlumeMeetingTurn.findMany({
				where: {
					...scope,
					...(input.sessionId ? { sessionId: input.sessionId } : {}),
					...(input.before
						? {
								OR: [
									{
										createdAt: {
											lt: input.before.createdAt,
										},
									},
									{
										createdAt: input.before.createdAt,
										id: { lt: input.before.id },
									},
								],
							}
						: {}),
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 31,
				select: {
					id: true,
					sessionId: true,
					speakerId: true,
					speakerName: true,
					requestText: true,
					responseText: true,
					status: true,
					error: true,
					createdAt: true,
					startedAt: true,
					completedAt: true,
					firstAudioAt: true,
					spokenAt: true,
					interruptedAt: true,
					session: {
						select: { agentLabel: true, toolsReadOnly: true },
					},
					actions: {
						orderBy: { createdAt: "asc" },
						select: {
							id: true,
							toolName: true,
							arguments: true,
							summary: true,
							status: true,
							createdAt: true,
							presentedAt: true,
							expiresAt: true,
							confirmedAt: true,
							completedAt: true,
							confirmationTurnId: true,
							outcome: true,
						},
					},
				},
			}),
			input.before
				? Promise.resolve(null)
				: db.parlumeMeetingTurn.count({ where: scope }),
		]);
		const items = turns.slice(0, 30);
		const last = items.at(-1);
		return {
			items,
			total,
			nextCursor:
				turns.length > 30 && last
					? { id: last.id, createdAt: last.createdAt }
					: null,
		};
	});
