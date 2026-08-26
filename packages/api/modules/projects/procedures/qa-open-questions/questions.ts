import { ORPCError } from "@orpc/server";
import {
	createQaOpenQuestion,
	deleteQaOpenQuestion,
	listQaOpenQuestions,
	QA_OPEN_QUESTIONS_MAX_LIMIT,
	updateQaOpenQuestion,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * The QA open-questions log (QA capability mocks, screen A5).
 *
 * Reading is gated on TEST_CASE_READ and writing on TEST_CASE_UPDATE — the same
 * gates the rest of the QA surface uses, so a project member who can see test
 * cases can see the unknowns raised against them.
 *
 * Every procedure is scoped by `projectId` and NEVER trusts a caller-supplied
 * organization: `requireProjectPermission` is the tenant boundary (the SOC 2
 * ratchet the pipeline-results procedures established).
 */

const STATUS = z.enum(["OPEN", "ANSWERED", "DEFERRED"]);

export const listQaOpenQuestionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa-open-questions",
		tags: ["Projects", "Test Cases"],
		summary: "List the project's QA open questions",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** Omitted = every status, which is what the "All" filter sends. */
			status: STATUS.optional(),
			userStoryId: z.string().optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(QA_OPEN_QUESTIONS_MAX_LIMIT)
				.optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input }) => listQaOpenQuestions(input));

export const createQaOpenQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa-open-questions",
		tags: ["Projects", "Test Cases"],
		summary: "Record a QA open question",
	})
	.input(
		z.object({
			projectId: z.string(),
			question: z.string().trim().min(1).max(2000),
			userStoryId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// The asker label is derived server-side from the session, never taken
		// from the client — otherwise anyone could file a question attributed to
		// someone else, or to an AI persona that never ran.
		return createQaOpenQuestion({
			projectId: input.projectId,
			question: input.question,
			askedByLabel: user.name || user.email || "Unknown",
			askedById: user.id,
			userStoryId: input.userStoryId ?? null,
		});
	});

export const updateQaOpenQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/qa-open-questions/{questionId}",
		tags: ["Projects", "Test Cases"],
		summary: "Answer, defer or reopen a QA open question",
	})
	.input(
		z.object({
			projectId: z.string(),
			questionId: z.string(),
			status: STATUS,
			answer: z.string().trim().max(4000).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const result = await updateQaOpenQuestion({
			projectId: input.projectId,
			questionId: input.questionId,
			status: input.status,
			answer: input.answer,
			answeredById: context.user.id,
		});
		// updateMany reports 0 for a question that belongs to another project —
		// a 404 rather than a silent success, so a wrong id is visible.
		if (result.updated === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "That question no longer exists in this project.",
			});
		}
		return result;
	});

export const deleteQaOpenQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/qa-open-questions/{questionId}",
		tags: ["Projects", "Test Cases"],
		summary: "Delete a QA open question",
	})
	.input(z.object({ projectId: z.string(), questionId: z.string() }))
	.handler(async ({ input }) => {
		const result = await deleteQaOpenQuestion(input);
		if (result.deleted === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "That question no longer exists in this project.",
			});
		}
		return result;
	});
