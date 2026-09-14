import { ORPCError } from "@orpc/client";
import {
	getProjectMembers,
	getPublishingTopic,
	resolveProjectTenant,
	setTopicQuestionAssignees,
} from "@repo/database";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/** Same ceiling as the topic's own assignee list: one request cannot name the
 *  whole directory. A question realistically waits on one or two people. */
const MAX_ASSIGNEES = 50;

/**
 * `publishingSuite.setQuestionAssignees` (Fizzy #1851) — route one open
 * question on a topic to the people who can answer it.
 *
 * SET SEMANTICS: the input carries the COMPLETE desired list, so assigning,
 * re-assigning and clearing are one call and the client never diffs. Only
 * newly-added people are notified, so a bare re-save is silent.
 *
 * NOT ACCESS CONTROL. Anyone who may edit the topic may change who a question
 * is waiting on, and assignment never restricts who can answer it. There is
 * deliberately no check that the caller is the author or an existing assignee —
 * the same call `PUBLISHING_TOPIC_UPDATE` above already gates.
 *
 * NEVER RESOLVES ANYTHING. Asking somebody is not answering: the root stays
 * OPEN and no reply turn is written. `answerTopicQuestion` is the only path
 * that settles a question, and routing an ask through it would close the very
 * question being asked.
 */
export const setPublishingQuestionAssigneesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/decisions/{questionRootId}/assignees",
		tags: ["Projects", "Publishing Suite"],
		summary: "Set who a topic's open question is waiting on",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			/** The question thread ROOT, not a reply. */
			questionRootId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** The COMPLETE desired set; empty clears the question. */
			assigneeUserIds: z.array(z.string()).max(MAX_ASSIGNEES),
			/**
			 * The sentence that explains the ask.
			 *
			 * Without it, routing a question notified somebody with nothing but
			 * "you have been assigned" — the recipient arrives at a bare
			 * assignment and has to guess why. Stored as a real reply turn, so
			 * it renders under the question with its author and its time.
			 */
			note: z.string().trim().max(2000).optional(),
		}),
	)
	.output(
		z.object({
			assigneeUserIds: z.array(z.string()),
			notifiedUserIds: z.array(z.string()),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		const user = context.user;

		// Every submitted id MUST be a CURRENT project member.
		//
		// The same name-disclosure-oracle protection `update-topic-assignees.ts`
		// documents: the ids written here are later fed to an unscoped user
		// lookup that resolves display names and avatars, so an unchecked id
		// would let any caller read back an arbitrary user's identity. And as
		// there, no grandfather rule — every id in this table got there by
		// passing this same check, so a non-member can only mean somebody who
		// has since left the project, and dropping them is correct.
		if (input.assigneeUserIds.length > 0) {
			const members = await getProjectMembers(input.projectId);
			const memberIds = new Set(members.map((m) => m.userId));
			const stranger = input.assigneeUserIds.find(
				(id) => !memberIds.has(id),
			);
			if (stranger !== undefined) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Assignees must be current project members",
				});
			}
		}

		const result = await setTopicQuestionAssignees({
			topicId: input.topicId,
			projectId: input.projectId,
			entryId: input.questionRootId,
			assigneeUserIds: input.assigneeUserIds,
			assignedByUserId: user.id,
			assignedByName: user.name ?? null,
			note: input.note?.trim() || null,
		});
		// `null` is "no such question in this topic and project". Reporting it
		// as a successful no-op would leave the picker showing avatars the
		// server never stored.
		if (result === null) {
			throw new ORPCError("NOT_FOUND", { message: "Question not found" });
		}
		const added = result.added;
		const note = input.note?.trim() || undefined;

		/**
		 * An ask carrying a note is a MESSAGE, not just a routing change, so
		 * everyone the question is now waiting on hears it — not only the
		 * people this call added. Re-asking somebody already assigned is the
		 * ordinary way a second question gets asked, and `added` is empty for
		 * exactly that person, so the note would otherwise reach nobody.
		 *
		 * Without a note the original rule stands: re-saving an unchanged set
		 * is silent, so toggling avatars in the picker never spams the room.
		 */
		const recipientUserIds = note
			? [...new Set([...added, ...input.assigneeUserIds])]
			: added;

		if (recipientUserIds.length > 0) {
			// Fire-and-forget: a notification failure must never fail the write
			// the user actually asked for.
			//
			// The tenant comes from the PROJECT row and NOT from
			// `input.organizationId` — a caller-supplied tenant is never
			// membership-checked, and the pairing of a project someone may
			// legitimately reach with an organization they may not is the shape
			// every cross-tenant leak in this area has had.
			void (async () => {
				const [tenant, topic] = await Promise.all([
					resolveProjectTenant(input.projectId),
					getPublishingTopic({
						id: input.topicId,
						projectId: input.projectId,
						viewerUserId: user.id,
					}),
				]);
				await fanOut.publishingQuestionAssigned({
					recipientUserIds,
					topicId: input.topicId,
					topicTitle: topic?.topic.title ?? "a publishing topic",
					questionRootId: input.questionRootId,
					questionSummary: result.summary ?? "Open question",
					projectId: input.projectId,
					organizationId: tenant?.organizationId ?? null,
					actorUserId: user.id,
					actorName: user.name ?? "Someone",
					// Context-relative, like every other in-app link: the bell
					// prepends the notification's OWN workspace base, so this
					// must not carry `/app` or an org slug of its own. The
					// question anchor is appended by the fan-out.
					link: `projects/${input.projectId}/publishing/${input.topicId}`,
					note,
					noteEntryId: result.noteEntryId ?? undefined,
				});
			})().catch((error) => {
				console.warn(
					"[notification-service] Publishing question assignee fan-out failed:",
					error,
				);
			});
		}

		return {
			assigneeUserIds: [...new Set(input.assigneeUserIds)],
			notifiedUserIds: recipientUserIds,
		};
	});
