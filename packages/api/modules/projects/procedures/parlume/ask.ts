import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal/client";
import {
	parseParlumeConfidentialCommand,
	parseParlumeConfidentialRequest,
} from "@repo/utils/parlume-confidential";
import { z } from "zod";
import { mintParlumeActingGrantForTurn } from "../../../../lib/agent-service-auth";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { mayReadParlumeSessionContent } from "../../lib/parlume-confidential";
import { parlumeLog } from "../../lib/parlume-log";
import { requireParlumeProject } from "./sessions";

/** About a page of text: a question, not a document. */
const PARLUME_PAGE_QUESTION_CHARS = 2000;

/**
 * A page question still unanswered after this long has outlived its turn's
 * three-minute limit, so it no longer holds back the next one.
 */
const PAGE_QUESTION_IN_FLIGHT_MS = 5 * 60_000;

const DISPATCH_FAILED = "Parlume turn dispatch failed.";

/**
 * A project member asks Parlume a question on the Parlume page while it is in
 * a meeting. The question takes the turn path a meeting request takes (the
 * same agent, the asker's own project access, proposals a member confirms),
 * but the answer stays on the page: nothing is spoken or posted in the
 * meeting, so guests never see it. It does not take the voice's turn, so the
 * meeting is never kept waiting by it, and stopping the voice does not end it.
 * One question at a time for each member.
 */
export const askParlumeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/parlume/sessions/{sessionId}/ask",
		tags: ["Projects", "Parlume"],
		summary: "Ask Parlume a question on the page, away from the meeting",
	})
	.input(
		z.object({
			projectId: z.string(),
			sessionId: z.string(),
			text: z.string().trim().min(1).max(PARLUME_PAGE_QUESTION_CHARS),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await requireParlumeProject(input.projectId);
		const session = await db.parlumeMeetingSession.findFirst({
			where: {
				id: input.sessionId,
				projectId: project.id,
				organizationId: project.organizationId,
				status: "ACTIVE",
			},
			select: {
				id: true,
				userId: true,
				voiceGeneration: true,
				confidential: true,
				attendeeUserIds: true,
			},
		});
		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Parlume is not in this meeting.",
			});
		}
		// The answer may draw on the meeting's confidential part, so only its
		// readers ask while the meeting is confidential.
		if (
			!(await mayReadParlumeSessionContent({
				projectId: project.id,
				userId: context.user.id,
				session,
			}))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only the people in this confidential meeting and project managers can ask Parlume about it.",
			});
		}
		// Typed here, the command would only be answered, never applied.
		if (
			parseParlumeConfidentialRequest(input.text) ||
			parseParlumeConfidentialCommand(input.text)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"To start or end the meeting's confidential part, use Confidential from now or End confidential part on this page.",
			});
		}
		const inFlight = await db.parlumeMeetingTurn.findFirst({
			where: {
				sessionId: session.id,
				replyChannel: "PAGE",
				requesterUserId: context.user.id,
				status: { in: ["PENDING", "RUNNING"] },
				createdAt: {
					gte: new Date(Date.now() - PAGE_QUESTION_IN_FLIGHT_MS),
				},
			},
			select: { id: true },
		});
		if (inFlight) {
			throw new ORPCError("CONFLICT", {
				message: "Parlume is still answering your last question.",
			});
		}
		const turn = await db.parlumeMeetingTurn.create({
			data: {
				sessionId: session.id,
				projectId: project.id,
				organizationId: project.organizationId,
				userId: session.userId,
				requesterUserId: context.user.id,
				dedupeKey: `page:${randomUUID()}`,
				requestText: input.text,
				speakerName: context.user.name ?? null,
				speakerId: null,
				voiceGeneration: session.voiceGeneration,
				replyChannel: "PAGE",
			},
			select: { id: true },
		});
		try {
			const temporal = await getTemporalClient();
			// The grant reads with the asker's access, as for a request in the
			// meeting; it travels only in the workflow's input. The asker may
			// read the meeting's confidential part (checked above), and nobody
			// else sees the answer as it is written.
			await temporal.workflow.start("parlumeMeetingTurnWorkflow", {
				taskQueue: "fabric-worker",
				workflowId: `parlume-turn-${turn.id}`,
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [
					{
						turnId: turn.id,
						jobType: "parlume-live-turn",
						actingGrant: mintParlumeActingGrantForTurn({
							userId: context.user.id,
							organizationId: project.organizationId,
							projectId: project.id,
						}),
						withConfidential: true,
					},
				],
			});
		} catch {
			await db.parlumeMeetingTurn.update({
				where: { id: turn.id },
				data: {
					status: "FAILED",
					error: DISPATCH_FAILED,
					completedAt: new Date(),
				},
			});
			parlumeLog("warn", "page_question.dispatch_failed", {
				sessionId: session.id,
				turnId: turn.id,
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Parlume could not take the question. Try again.",
			});
		}
		return { turnId: turn.id };
	});
