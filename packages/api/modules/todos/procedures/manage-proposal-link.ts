/**
 * Accept or reject the tie between a to-do's meeting item and a work item,
 * from the To Do page (Fizzy #2340).
 *
 * THE POINT OF THIS PROCEDURE IS THAT IT WRITES NOTHING OF ITS OWN. The meeting
 * digest already has a surface for exactly this decision
 * (`meeting-digest/manage-action-item-links.ts`), and a to-do page that kept its
 * own idea of "rejected" would produce the one failure this unit exists to
 * prevent: a link the person removed on one screen still showing on the other,
 * or — worse — the matcher re-suggesting on Tuesday exactly what they rejected
 * on Monday. So both directions delegate to the SAME two writers the digest
 * uses, `upsertPersonLink` and `dismissActionItemLink`, and rejection is the
 * same `status: DISMISSED` TOMBSTONE rather than a delete. The tombstone is what
 * makes the rejection durable: `listDecidedLinkKeys` reads rows of every status,
 * so a dismissed pair is a decided pair and the next matching run leaves it
 * alone. A hard delete could not express that.
 *
 * THE ONE CASE THE DIGEST SIDE CANNOT REACH is a work item that an approved
 * proposal produced while `MEETING_ACTION_ITEM_LINKING` was off: the story
 * exists, no link was ever written, and the digest's remove takes a `linkId`
 * there is none of. Rejecting it here therefore creates the row through
 * `upsertPersonLink` and immediately tombstones it through
 * `dismissActionItemLink` — the result is byte-for-byte the row the digest side
 * would have produced had the person added and then removed the link, and the
 * pair is decided before the matcher ever sees it.
 *
 * TWO LAYERS OF AUTHORIZATION, and the second is the one that matters here.
 *
 *  1. `requireInputOrgPermission(TODO_UPDATE, { requireOrganization: true })`
 *     proves the caller belongs to the organization NAMED IN THE INPUT.
 *     `requirePermission` would have checked their SESSION org role — how a
 *     member of one tenant borrows their own role to act on another's — and
 *     `requireOrganization: true` is mandatory because without it an explicit
 *     `organizationId: null` resolves to nothing and skips the role check.
 *  2. THAT IS NOT SUFFICIENT. This endpoint is keyed by TO-DO id and writes a
 *     tombstone onto a PROJECT's meeting digest. Organization membership does
 *     not bind the caller to that project, and the module's own rule — the
 *     read's visibility predicate — has arms that pass with no project at all
 *     (a row assigned to the caller, the Unassigned bucket, a MANUAL row they
 *     wrote), which is correct for a to-do page and would be a hole here. So
 *     the project that owns the MEETING is resolved
 *     from the transcript and checked with `PROJECT_READ`, the same permission
 *     the digest sibling requires for exactly the same write. A caller who can
 *     name a to-do id must not be able to dismiss links on a project they were
 *     never granted.
 *
 * NO AUDIT ROW, matching the digest sibling deliberately rather than by
 * omission. A link is navigational: neither direction can change a work item's
 * content, create one, or alter who may see anything. The sibling records none
 * for the same reason, and a to-do-side entry with no digest-side counterpart
 * would make the audit log disagree with itself about the same act.
 */

import { ORPCError } from "@orpc/server";
import {
	db,
	dismissActionItemLink,
	isFeatureEnabled,
	upsertPersonLink,
} from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	requireTodoListEnabled,
	requireTodoMutationAccess,
} from "../lib/mutation-access";
import {
	requireWritableBinding,
	resolveTodoMeetingBinding,
} from "../lib/proposal-links";
import { requireOrganizationContext } from "./contacts/shared";

export const manageProposalLinkInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	todoId: z.string().min(1),
	storyId: z.string().min(1),
	/**
	 * ONE procedure for both directions, with the direction in the input,
	 * because they are one decision a person can change their mind about rather
	 * than two events — the same shape `todos.complete` settled on, and the
	 * reason `upsertPersonLink` is a revive path rather than an insert.
	 */
	action: z.enum(["accept", "reject"]),
});

export const manageProposalLinkProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos/{todoId}/work-items/{storyId}/link",
		tags: ["Todos"],
		summary: "Accept or reject a to-do's link to a work item",
		description:
			"Accepting revives or creates the link; rejecting writes the same DISMISSED tombstone the meeting digest writes, so the next matching run cannot re-suggest what the user just rejected and the two surfaces can never disagree.",
	})
	.input(manageProposalLinkInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
			// NOT_FOUND rather than FORBIDDEN, exactly as the digest sibling
			// answers: with the flag off the endpoint does not exist as far as a
			// caller is concerned, and the client never renders a control that
			// reaches it.
			throw new ORPCError("NOT_FOUND", { message: "Not found" });
		}

		const now = new Date();
		const todo = await requireTodoMutationAccess({
			todoId: input.todoId,
			organizationId,
			viewerUserId: context.user.id,
			now,
		});

		const binding = requireWritableBinding(
			await resolveTodoMeetingBinding({ todo, organizationId }),
		);

		// The second layer. The project comes from the TRANSCRIPT — the meeting
		// whose digest this write lands in — and never from the caller's input.
		await assertProjectPermission(
			binding.projectId,
			context.user.id,
			Permissions.PROJECT_READ,
			context,
		);

		// Resolved under the project scope, the way the digest side resolves it,
		// so a work item from another project is unfindable rather than merely
		// unauthorized.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: binding.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found",
			});
		}

		const liveItem = binding.liveActionItem;
		if (!liveItem) {
			// Unreachable: `requireWritableBinding` refuses a binding with no
			// link key, and the link key exists only when a live item does. Kept
			// because the tenancy and the snapshot below are both read off it,
			// and a silent `undefined` there would write a link nobody can see.
			throw new ORPCError("CONFLICT", {
				message: "This to-do's meeting item is no longer available",
			});
		}

		if (input.action === "accept") {
			const link = await upsertPersonLink({
				transcriptId: binding.transcriptRowId,
				projectId: binding.projectId,
				itemKey: binding.linkItemKey,
				itemTextSnapshot: liveItem.text,
				storyId: story.id,
				// MANUAL, not CREATED: a person chose this, whatever produced
				// the suggestion. The digest reads CREATED as "this ticket came
				// from here" and MANUAL as "somebody tied these together", and
				// accepting is the second of those.
				origin: "MANUAL",
				createdById: context.user.id,
				// Tenancy COPIED from the parent transcript, never derived from
				// the request — a link must sit in the same RLS scope as the
				// meeting it belongs to.
				userId: binding.tenancy.userId,
				organizationId: binding.tenancy.organizationId,
			});
			return {
				todoId: todo.id,
				storyId: story.id,
				action: "accept" as const,
				linkId: link.id,
				status: "ACTIVE" as const,
				changed: true,
			};
		}

		const existing = await db.meetingActionItemLink.findUnique({
			where: {
				transcriptId_itemKey_storyId: {
					transcriptId: binding.transcriptRowId,
					itemKey: binding.linkItemKey,
					storyId: story.id,
				},
			},
			select: { id: true, status: true },
		});

		if (existing?.status === "DISMISSED") {
			// Already decided, and re-writing the tombstone would move
			// `dismissedAt`/`dismissedById` off the person who actually made the
			// decision. Reported as a no-op rather than as a failure: the user's
			// intent is satisfied.
			return {
				todoId: todo.id,
				storyId: story.id,
				action: "reject" as const,
				linkId: existing.id,
				status: "DISMISSED" as const,
				changed: false,
			};
		}

		// No row yet — the proposal was approved while the linking flag was off,
		// so the story exists and the link never did. Create it through the
		// shared writer and tombstone it, which lands the same row the digest
		// side would have. `CREATED` because the proposal genuinely produced the
		// work item; that is what the row records, and dismissing it is what the
		// person decided about it.
		const linkId =
			existing?.id ??
			(
				await upsertPersonLink({
					transcriptId: binding.transcriptRowId,
					projectId: binding.projectId,
					itemKey: binding.linkItemKey,
					itemTextSnapshot: liveItem.text,
					storyId: story.id,
					origin: "CREATED",
					createdById: context.user.id,
					userId: binding.tenancy.userId,
					organizationId: binding.tenancy.organizationId,
				})
			).id;

		const dismissed = await dismissActionItemLink({
			linkId,
			// The scope guard the shared writer applies: a link id from another
			// project is unmatchable rather than merely unauthorized.
			projectId: binding.projectId,
			dismissedById: context.user.id,
		});
		if (!dismissed) {
			// The row went away between the read and the write.
			throw new ORPCError("NOT_FOUND", { message: "Link not found" });
		}

		return {
			todoId: todo.id,
			storyId: story.id,
			action: "reject" as const,
			linkId,
			status: "DISMISSED" as const,
			changed: true,
		};
	});
