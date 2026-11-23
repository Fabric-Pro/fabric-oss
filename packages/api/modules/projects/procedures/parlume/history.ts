import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { effectiveParlumeActionStatus } from "../../lib/parlume-actions";
import { withheldConfidentialParlumeSessions } from "../../lib/parlume-confidential";
import { parlumeSpeakerMark } from "../../lib/parlume-guests";
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
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		// The requests of a confidential meeting, and Parlume's answers to
		// them, are for its verified attendees and the project's managers.
		const { sessionIds: withheld } =
			await withheldConfidentialParlumeSessions({
				projectId: project.id,
				userId: context.user.id,
			});
		const scope = {
			projectId: project.id,
			organizationId: project.organizationId,
			...(withheld.size > 0
				? { sessionId: { notIn: [...withheld] } }
				: {}),
		};
		// All of the project's requests, whatever session is being viewed, for
		// the page's tab summary; later pages do not repeat the count.
		const [turns, total] = await Promise.all([
			db.parlumeMeetingTurn.findMany({
				where: {
					...scope,
					...(input.sessionId
						? {
								sessionId: withheld.has(input.sessionId)
									? { in: [] }
									: input.sessionId,
							}
						: {}),
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
					requesterUserId: true,
					requestText: true,
					responseText: true,
					replyChannel: true,
					status: true,
					error: true,
					createdAt: true,
					startedAt: true,
					completedAt: true,
					firstAudioAt: true,
					spokenAt: true,
					interruptedAt: true,
					stopCause: true,
					stoppedBy: true,
					chatTags: true,
					chatUnshownTags: true,
					session: {
						select: {
							agentLabel: true,
							toolsReadOnly: true,
							memberSpeakerIds: true,
							guestSpeakerIds: true,
						},
					},
					actions: {
						orderBy: { createdAt: "asc" },
						select: {
							id: true,
							toolName: true,
							arguments: true,
							summary: true,
							status: true,
							expiresAt: true,
							chatTag: true,
							chatDelivery: true,
							createdAt: true,
							completedAt: true,
							outcome: true,
						},
					},
				},
			}),
			input.before
				? Promise.resolve(null)
				: db.parlumeMeetingTurn.count({ where: scope }),
		]);
		const now = new Date();
		// Each asker is marked as the transcript marks them. The participants'
		// Teams ids and the asker's account stay on the server.
		const items = turns.slice(0, 30).map((turn) => {
			const {
				requesterUserId,
				session: { memberSpeakerIds, guestSpeakerIds, ...session },
				...rest
			} = turn;
			return {
				...rest,
				session,
				speakerMark: parlumeSpeakerMark(
					{
						id: turn.speakerId,
						name: turn.speakerName,
						userId: requesterUserId,
					},
					{ memberSpeakerIds, guestSpeakerIds },
				),
				actions: turn.actions.map((action) => ({
					...action,
					status: effectiveParlumeActionStatus(action, now),
				})),
			};
		});
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
