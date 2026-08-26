/**
 * The QA open-questions log (QA capability mocks, screen A5).
 *
 * Testing unknowns raised during planning — "is the 60s SLA in scope, or just
 * functional correctness?" — used to live as prose inside a QA analysis, so
 * nothing could list what was still open, who raised it, or whether it was ever
 * answered. These queries make them a status-tracked record.
 *
 * Scoped by `projectId`, which is the tenant boundary here: the caller's
 * permission on the project is checked by the procedure layer, so no
 * caller-supplied org is trusted (the SOC 2 ratchet the pipeline-results
 * procedures follow).
 */

import { db, type QaOpenQuestionStatus } from "../../client";

/** Page size ceiling — the log is a working list, not an archive dump. */
export const QA_OPEN_QUESTIONS_MAX_LIMIT = 200;

export interface QaOpenQuestionView {
	id: string;
	question: string;
	answer: string | null;
	status: QaOpenQuestionStatus;
	askedByLabel: string;
	answeredAt: Date | null;
	createdAt: Date;
	userStory: { id: string; identifier: string | null; title: string } | null;
}

const questionSelect = {
	id: true,
	question: true,
	answer: true,
	status: true,
	askedByLabel: true,
	answeredAt: true,
	createdAt: true,
	userStory: { select: { id: true, identifier: true, title: true } },
} as const;

export async function listQaOpenQuestions(input: {
	projectId: string;
	/** Omitted = every status, which is what the "All" filter sends. */
	status?: QaOpenQuestionStatus;
	/** Narrow to one feature's questions. */
	userStoryId?: string;
	limit?: number;
	offset?: number;
}): Promise<{ items: QaOpenQuestionView[]; total: number }> {
	const where = {
		projectId: input.projectId,
		...(input.status ? { status: input.status } : {}),
		...(input.userStoryId ? { userStoryId: input.userStoryId } : {}),
	};
	const take = Math.min(
		Math.max(1, input.limit ?? 50),
		QA_OPEN_QUESTIONS_MAX_LIMIT,
	);

	const [items, total] = await Promise.all([
		db.qaOpenQuestion.findMany({
			where,
			select: questionSelect,
			// Open questions first — the log is a queue, and an answered item
			// scrolling above an unanswered one buries the actionable ones.
			orderBy: [{ status: "asc" }, { createdAt: "desc" }],
			take,
			skip: input.offset ?? 0,
		}),
		db.qaOpenQuestion.count({ where }),
	]);
	return { items, total };
}

export async function createQaOpenQuestion(input: {
	projectId: string;
	question: string;
	askedByLabel: string;
	askedById?: string | null;
	userStoryId?: string | null;
}): Promise<{ id: string }> {
	// Tenancy is COPIED FROM THE PARENT PROJECT, never taken from the caller —
	// the same rule ProjectQaSettings follows, so a caller cannot file a row
	// into another tenant by supplying its own ids.
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { organizationId: true, userId: true },
	});
	return db.qaOpenQuestion.create({
		data: {
			projectId: input.projectId,
			organizationId: project?.organizationId ?? null,
			userId: project?.userId ?? null,
			question: input.question,
			askedByLabel: input.askedByLabel,
			askedById: input.askedById ?? null,
			userStoryId: input.userStoryId ?? null,
		},
		select: { id: true },
	});
}

/**
 * Answer, defer, or reopen a question.
 *
 * `answeredAt` is stamped when it moves to ANSWERED and cleared on any other
 * transition, so a reopened question cannot keep claiming it was answered at a
 * time when it was not. The WHERE re-scopes by `projectId` — a belt-and-braces
 * tenant guard on the write, matching the pipeline-results denorm.
 */
export async function updateQaOpenQuestion(input: {
	projectId: string;
	questionId: string;
	status: QaOpenQuestionStatus;
	answer?: string | null;
	answeredById?: string | null;
}): Promise<{ updated: number }> {
	const answering = input.status === "ANSWERED";
	const result = await db.qaOpenQuestion.updateMany({
		where: { id: input.questionId, projectId: input.projectId },
		data: {
			status: input.status,
			...(input.answer !== undefined ? { answer: input.answer } : {}),
			answeredAt: answering ? new Date() : null,
			answeredById: answering ? (input.answeredById ?? null) : null,
		},
	});
	return { updated: result.count };
}

export async function deleteQaOpenQuestion(input: {
	projectId: string;
	questionId: string;
}): Promise<{ deleted: number }> {
	const result = await db.qaOpenQuestion.deleteMany({
		where: { id: input.questionId, projectId: input.projectId },
	});
	return { deleted: result.count };
}
