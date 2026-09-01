import { ORPCError } from "@orpc/client";
import {
	appendDecisionLogReply,
	db,
	getDecisionLogEntryById,
	hasProjectAccess,
	setQuestionAssignees,
} from "@repo/database";
import { z } from "zod";
import { fanOut } from "../../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * `maturation.setQuestionAssignees` (Fizzy #1751) — route an open question to
 * the people who can answer it.
 *
 * SET SEMANTICS: the input carries the complete desired assignee list, so
 * assigning (AC-1/2), re-assigning (AC-5) and clearing (AC-6) are one call and
 * the client never diffs. Only newly-added assignees are notified; re-saving an
 * unchanged set is silent.
 *
 * NOT ACCESS CONTROL (AC-7): any project member may change the assignees, and
 * assignment never restricts who can answer. There is deliberately no check that
 * the caller is the author or an existing assignee.
 *
 * NEVER RESOLVES ANYTHING. This is the `Ask` half of the mention split: the
 * question stays OPEN and the optional `note` is appended as a plain reply turn
 * so the assignee can see what they are being asked to confirm. Routing an
 * "Ask" through `answerQuestion` instead would flip the root to RESOLVED and
 * close the very question being asked.
 *
 * PM-SYNC ISOLATION (§7.7): writes only assignment rows and an optional Decision
 * Log reply — never `description`/`acceptanceCriteria`, so it must not trigger PM
 * sync. This file does not import `enqueuePmSync`.
 */
export const setQuestionAssigneesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/question-assignees",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Set the assignees on an open question",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			/** The question thread root id. */
			questionRootId: z.string(),
			/** The COMPLETE desired assignee set; empty clears the question. */
			assigneeUserIds: z.array(z.string()).max(50),
			/**
			 * Optional context to keep alongside the assignment — the sentence the
			 * asker had typed ("it should be ninety days, right?"). Stored as a
			 * reply turn, never as an answer.
			 */
			note: z.string().max(10_000).optional(),
			/** Feature link used to build the notification deep-link. */
			link: z.string().max(2_000),
		}),
	)
	.output(
		z.object({
			assigneeUserIds: z.array(z.string()),
			notifiedUserIds: z.array(z.string()),
		}),
	)
	.handler(async ({ input, context }) => {
		// The organization is NEVER taken from caller input. `hasProjectAccess`
		// and `requireProjectPermission` both authorize on (projectId, userId)
		// and ignore the org, so trusting `input.organizationId` would let a
		// caller pair a project they legitimately reach with an organization
		// they do not — the shape that shipped a cross-tenant read in the
		// roadmap's open-decisions endpoint. Passing `undefined` falls through
		// to the tenant context's `effectiveWriteOrgId`, which
		// `requireProjectPermission` set from the PROJECT's own organization
		// earlier in this request.
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		const question = await getDecisionLogEntryById({
			tenantFilter,
			userStoryId: input.storyId,
			id: input.questionRootId,
		});
		if (!question) {
			throw new ORPCError("NOT_FOUND", { message: "Question not found" });
		}

		const added = await setQuestionAssignees({
			tenantFilter,
			entryId: input.questionRootId,
			assigneeUserIds: input.assigneeUserIds,
			assignedByUserId: context.user.id,
		});

		if (input.note && input.note.trim().length > 0) {
			await appendDecisionLogReply({
				tenantFilter,
				parentId: input.questionRootId,
				userStoryId: question.userStoryId,
				authorType: "USER",
				content: input.note,
				authorUserId: context.user.id,
			});
		}

		if (added.length > 0) {
			const story = await db.userStory.findUnique({
				where: { id: question.userStoryId },
				select: { title: true },
			});
			await fanOut.questionAssigned({
				recipientUserIds: added,
				questionRootId: input.questionRootId,
				questionSummary:
					question.summary ?? question.content ?? "Open question",
				storyId: input.storyId,
				storyTitle: story?.title ?? "a feature",
				projectId: input.projectId,
				organizationId: organizationId ?? null,
				actorUserId: context.user.id,
				actorName: context.user.name,
				link: input.link,
			});
		}

		return {
			assigneeUserIds: [...new Set(input.assigneeUserIds)],
			notifiedUserIds: added,
		};
	});
