/**
 * The consolidated To Do list's read (#2340).
 *
 * ONE organization-level call serves the whole page: the viewer's own to-dos
 * across every project they can reach, plus whatever their confirmed function
 * tags entitle them to see, with snooze, age and completion applied as the
 * requested `view` defines them.
 * The page is workspace-level and has no project in its route, so there is no
 * `projectId` for `requireProjectPermission` to authorize against — which is
 * exactly why the authorization here is in two halves and both are load-bearing:
 *
 *  1. `requireInputOrgPermission(TODO_READ, { requireOrganization: true })`
 *     proves the caller belongs to the organization NAMED IN THE INPUT.
 *     `requirePermission` would have checked their SESSION org role instead,
 *     which is how a member of one tenant borrows their own role to read
 *     another's. `requireOrganization: true` is not optional decoration:
 *     without it an explicit `organizationId: null` resolves to nothing and
 *     skips the role check entirely, and this procedure has no personal
 *     variant for that pass-through to be correct for.
 *  2. The organization check is where authorization STARTS, not where it ends.
 *     This query crosses every project in the tenant, so membership alone would
 *     hand a guest the whole organization's to-dos. The project-access
 *     predicate and the function-tag rules live in `../lib/visibility.ts` and
 *     are composed into the query itself.
 *
 * FOUR VIEWS, ONE ACCESS RULE. The page is not one list but four mutually
 * exclusive scopes of the same list — the working list, the completed archive,
 * what is asleep, and what the age cutoff removed — and `view` selects between
 * them. They are one enum rather than a boolean per rule because independent
 * flags would admit combinations nobody has defined an answer for, and because
 * a scope that can be COMBINED invites a scope that is also allowed to widen.
 * None of them may: every view composes the same `todoVisibilityCondition`
 * over the same organization, and the query applies it once, before any view
 * is derived (see `listVisibleTodos`). A view decides which of the rows this
 * caller may already see are kept, never who may see a row — a second copy of
 * the access rules per scope is how a tenant boundary rots.
 *
 * The response is an explicit DTO with ISO date strings, never Prisma rows —
 * the same rule the contact register follows, and for the same reason: this
 * surface carries the names of people outside the organization, and handing
 * the client whatever columns the model grows next is how internal fields leak
 * into it.
 */

import { ORPCError } from "@orpc/server";
import {
	db,
	isFeatureEnabled,
	listVisibleTodos,
	TODO_LIST_VIEWS,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	resolveTodoVisibility,
	TODO_AGE_THRESHOLD_DAYS,
	TODO_RECENCY_FLOOR,
	TODO_RECENT_COMPLETED_LIMIT,
	todoVisibilityCondition,
} from "../lib/visibility";
import { requireOrganizationContext } from "./contacts/shared";

/**
 * The page's input.
 *
 * `cursor` + `limit` + `hasMore` is the contract
 * `modules/notifications/procedures/list.ts` established. The limit is not
 * optional in spirit: the over-fetch idiom that keeps paging correct under an
 * access filter is meaningless without one, so it carries a default rather
 * than being allowed to mean "everything".
 */
export const listTodosInputSchema = z
	.object({
		organizationId: z.string().nullable().optional(),
		cursor: z.string().optional(),
		limit: z.number().int().min(1).max(100).default(50),
		/** Narrow to one project. Combines with the assignee filter by AND. */
		projectId: z.string().optional(),
		assigneeUserId: z.string().optional(),
		/** A non-member contact is filterable exactly like a member. */
		assigneeContactId: z.string().optional(),
		/**
		 * WHICH SCOPE of the list to return — one parameter, not a flag per
		 * rule.
		 *
		 * The four views are mutually exclusive by construction, and that is
		 * the reason they are an enum: as independent booleans they would admit
		 * combinations the product has never defined ("completed AND snoozed
		 * but not age-hidden"), and each caller would settle them differently.
		 * The values are `@repo/database`'s own, so a view added to the query
		 * widens this input rather than being a string the API accepts and the
		 * SQL ignores.
		 *
		 *  - `default`   the working list: open rows plus the two most recently
		 *                completed, with the age cutoff applied.
		 *  - `completed` every completed row, newest first. This replaces the
		 *                earlier `includeCompleted` flag, which could only ever
		 *                WIDEN the default list and so gave the page no way to
		 *                ask for the archive as a view of its own.
		 *  - `snoozed`   what is still asleep, soonest wake first, each row
		 *                carrying the `snoozedUntil` the page shows.
		 *  - `ageHidden` exactly the rows `ageHiddenCount` counts.
		 *
		 * Every view applies the SAME visibility and project-access predicate;
		 * see `../lib/visibility.ts`. A scope decides which of the rows the
		 * caller may already see are kept, never who may see them.
		 */
		view: z.enum(TODO_LIST_VIEWS).default("default"),
	})
	.refine((input) => !(input.assigneeUserId && input.assigneeContactId), {
		// A to-do carries `assigneeUserId` XOR `assigneeContactId`, so both
		// at once can only ever match nothing. Refusing is kinder than
		// silently returning an empty list that looks like "nobody owes
		// anything".
		message:
			"Filter by a member or by a contact, not both — a to-do has one or the other",
		path: ["assigneeContactId"],
	});

/**
 * One row as the To Do page renders it.
 *
 * Not exported: the client reads this shape off the router's inferred type, so
 * a second exported name would be a copy that nothing keeps honest.
 */
interface TodoListItem {
	id: string;
	source: "MEETING_DIGEST" | "MANUAL";
	/** What the row says. Live wording first, snapshot for an orphan. */
	title: string;
	projectId: string | null;
	projectName: string | null;
	/**
	 * WHETHER THIS ROW'S PROJECT WILL OPEN FOR THIS VIEWER — a RESOLVER
	 * OUTCOME, not a stored column, and that is the whole reason it is on the
	 * DTO rather than left to the page.
	 *
	 * `projectId` says which project a row BELONGS TO; only
	 * `openableProjectWhere` says whether that project will LOAD for this
	 * reader, and the To Do list is the one page in Fabric where those two
	 * routinely differ (#2615). A row can honestly be the viewer's own while
	 * its project is not theirs to open — the digest owner matcher assigns
	 * across the whole organization — so a client that inferred "there is a
	 * project id, therefore there is a link" offered links to "Project not
	 * found". It is told the answer instead of reconstructing it:
	 * `docs/solutions/architecture-patterns/ask-the-resolver-do-not-infer-from-stored-rows.md`.
	 *
	 * FALSE ON A PROJECT-LESS ROW, because there is no project to open.
	 * Deliberately false rather than null: it lets every project-scoped link on
	 * the page be withheld on ONE condition, with no second branch for "this
	 * row has no project at all".
	 */
	canOpenProject: boolean;
	assigneeUserId: string | null;
	assigneeUser: { id: string; name: string; image: string | null } | null;
	assigneeContactId: string | null;
	assigneeContact: { id: string; name: string } | null;
	tentativeOwnerName: string | null;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	suggestionCandidates: unknown;
	assignedManually: boolean;
	snoozedUntil: string | null;
	/** The one date the page shows, and the one the age rules key off. */
	sourceDate: string;
	completedAt: string | null;
	isCompleted: boolean;
	/** Completion the row cached before a rewording orphaned its binding. */
	lastKnownCompletedAt: string | null;
	isOrphaned: boolean;
	/**
	 * THE MEETING A ROW CAME FROM. Null on a manual to-do, and on nothing else.
	 *
	 * `meetingTranscriptRef` is the GRAPH transcript id — what
	 * `meetingDigest.getMeeting` and the digest deep link accept — and never
	 * the transcript row's cuid, which addresses nothing outside the database.
	 * `meetingItemKey` is the durable item key rather than an action item row
	 * id, because those ids are recreated on every extraction and a shared URL
	 * has to survive that. `meetingTitle` is resolved the way the digest itself
	 * resolves it — the occurrence's own subject, falling back to the series
	 * name — so the two surfaces can never disagree about what a meeting is
	 * called. The reverse order stood here until #2340: the series name is
	 * captured once at link time, so renaming a Teams series retitled every
	 * past occurrence under it.
	 *
	 * `meetingTranscriptRef` is also the exact grouping key for "from <meeting>"
	 * headings: grouping by `sourceDate` instead merges two meetings held the
	 * same day and splits one whose date was later corrected.
	 */
	meetingTranscriptRef: string | null;
	meetingItemKey: string | null;
	meetingTitle: string | null;
	meetingDate: string | null;
	createdAt: string;
	updatedAt: string;
}

const iso = (value: Date | null): string | null =>
	value === null ? null : value.toISOString();

export const listTodosProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/todos",
		tags: ["Todos"],
		summary: "List the caller's visible to-dos",
		description:
			"One organization-level read for the To Do page: the caller's own to-dos across every project they can reach, plus what their confirmed function tags let them see. `view` selects the scope — the working list, the completed archive, what is still snoozed, or what the age cutoff removed — and the same visibility rules apply in all four.",
	})
	.input(listTodosInputSchema)
	.handler(async ({ input, context }) => {
		// The same one-liner every other procedure in this module uses. Spelled
		// out here it drifted from its nine siblings the first time the message
		// or the error code changed in one place and not the others.
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);

		// A rollout gate, not a kill switch: off means the To Do page does not
		// exist, so the read refuses rather than returning an empty list that a
		// half-rendered page would show as "nothing to do". The contact
		// register deliberately sits outside this gate; this read does not.
		if (!(await isFeatureEnabled("TODO_LIST", organizationId))) {
			throw new ORPCError("NOT_FOUND", {
				message: "The To Do list is not available",
			});
		}

		// One clock for the whole request. Snooze, the age cutoff and the
		// membership-expiry checks all read it, and they must agree: a request
		// that sampled the clock three times could hide a row as snoozed and
		// count it as age-hidden in the same response.
		const now = new Date();

		const visibility = await resolveTodoVisibility({
			viewerUserId: context.user.id,
			organizationId,
			now,
		});

		const result = await listVisibleTodos({
			organizationId,
			visibilityCondition: todoVisibilityCondition(visibility),
			projectId: input.projectId,
			assigneeUserId: input.assigneeUserId,
			assigneeContactId: input.assigneeContactId,
			view: input.view,
			cursor: input.cursor,
			limit: input.limit,
			now,
			ageThresholdDays: TODO_AGE_THRESHOLD_DAYS,
			recencyFloor: TODO_RECENCY_FLOOR,
			recentCompletedLimit: TODO_RECENT_COMPLETED_LIMIT,
		});

		// Names for the page, batched off the RETURNED rows only. Every project
		// id reaching here already passed the visibility predicate, so no name
		// can leak through this hydration — the same reasoning the notification
		// list records for its project-name lookup.
		const projectIds = [
			...new Set(
				result.rows
					.map((row) => row.projectId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		const assigneeUserIds = [
			...new Set(
				result.rows
					.map((row) => row.assigneeUserId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		const contactIds = [
			...new Set(
				result.rows
					.map((row) => row.assigneeContactId)
					.filter((id): id is string => Boolean(id)),
			),
		];

		const [projects, users, contacts] = await Promise.all([
			projectIds.length
				? db.project.findMany({
						where: { id: { in: projectIds } },
						select: { id: true, name: true },
					})
				: [],
			assigneeUserIds.length
				? db.user.findMany({
						where: { id: { in: assigneeUserIds } },
						select: { id: true, name: true, image: true },
					})
				: [],
			contactIds.length
				? db.nonMemberContact.findMany({
						// `redactedAt: null` IS A DECISION, not a copy of the
						// register's filter.
						//
						// A redacted contact is a tombstone: `contacts.delete`
						// anonymises the row to "Removed contact" and detaches
						// every to-do that pointed at it, so a row reaching
						// this hydration still pointing at one is a row the
						// erasure did not reach — a write that raced it, or one
						// stored before `setTodoAssignee` closed that race.
						// Rendering the tombstone would give that row an
						// assignee named "Removed contact": a person-shaped
						// label for nobody, which also feeds the page's
						// assignee filter (`assigneeOptions` builds it from
						// these hydrated names) and would put the erased row
						// back in front of everyone as a facet to filter by.
						//
						// So the erasure's own answer is used instead. Every
						// row it detaches becomes unassigned, and a row it
						// missed is shown as what redaction intends it to be:
						// unassigned, in the Unassigned bucket, offering the
						// chips that let someone give it a real owner. The
						// stored pointer is not repaired here — a read must not
						// write — but nothing downstream is told that an erased
						// person still owes the work.
						where: {
							id: { in: contactIds },
							organizationId,
							redactedAt: null,
						},
						select: { id: true, name: true },
					})
				: [],
		]);

		// A Set, resolved ONCE for the page rather than a linear scan per row:
		// a page is up to 50 rows and every one of them asks this same
		// question, so `.includes` inside the mapper makes the cost of the
		// answer quadratic in the size of the viewer's project list.
		const openableProjectIds = new Set(visibility.openableProjectIds);

		const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
		const userById = new Map(users.map((u) => [u.id, u]));
		const contactById = new Map(contacts.map((c) => [c.id, c]));

		const items: TodoListItem[] = result.rows.map((row) => {
			// The id travels with the name or not at all. `isUnassigned` on the
			// page reads the ID (`assigneeUserId === null && assigneeContactId
			// === null`) while the row renders from the hydrated OBJECT, so a
			// row that kept the id of a contact this read would not hydrate —
			// a redacted one — would be shown with no assignee and still be
			// excluded from the Unassigned bucket and from the suggestion
			// chips: assigned to nobody, and not offerable to anyone.
			const assigneeContact = row.assigneeContactId
				? (contactById.get(row.assigneeContactId) ?? null)
				: null;

			return {
				id: row.id,
				source: row.source,
				// A meeting-sourced row shows the live action item's wording while
				// its binding resolves; the snapshot is the fallback that lets an
				// orphan still say what it was about.
				title: row.liveText ?? row.itemTextSnapshot ?? row.title ?? "",
				projectId: row.projectId,
				projectName: row.projectId
					? (projectNameById.get(row.projectId) ?? null)
					: null,
				// The resolver's answer, asked of the strict set and of
				// nothing else. A project-less row is false — see the field's
				// docblock — because there is no project for a link to reach.
				canOpenProject:
					row.projectId !== null &&
					openableProjectIds.has(row.projectId),
				assigneeUserId: row.assigneeUserId,
				assigneeUser: row.assigneeUserId
					? (userById.get(row.assigneeUserId) ?? null)
					: null,
				assigneeContactId: assigneeContact?.id ?? null,
				assigneeContact,
				// The extractor's free-text owner guess. Sent so an unassigned row can
				// offer "add <name> as a contact and assign" at the moment of need
				// rather than sending the PM to settings first. It is a guess, and
				// the page must present it as one.
				tentativeOwnerName: row.tentativeOwnerName,
				suggestedUserId: row.suggestedUserId,
				suggestedContactId: row.suggestedContactId,
				suggestionCandidates: row.suggestionCandidates ?? null,
				assignedManually: row.assignedManually,
				snoozedUntil: iso(row.snoozedUntil),
				sourceDate: row.sourceDate.toISOString(),
				completedAt: iso(row.effectiveCompletedAt),
				isCompleted: row.effectiveCompletedAt !== null,
				lastKnownCompletedAt: iso(row.lastKnownCompletedAt),
				isOrphaned: row.isOrphaned,
				meetingTranscriptRef: row.meetingTranscriptRef,
				meetingItemKey: row.itemKey,
				meetingTitle: row.meetingTitle,
				meetingDate: iso(row.meetingDate),
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			};
		});

		return {
			items,
			nextCursor: result.nextCursor,
			hasMore: result.hasMore,
			/**
			 * THE CURSOR NAMED A ROW THIS READ CAN NO LONGER PLACE.
			 *
			 * The list is live, and this page's client is the one that empties
			 * it: `TodoAgeHiddenView` resolves rows out of the very set it is
			 * paging. When the cursor row has gone entirely — deleted, no
			 * longer visible to this caller, or missing the column its view
			 * orders by — there is no page after it to return, and the read
			 * says so here rather than answering with the FIRST page under a
			 * cursor. A client that appends cannot tell that apart from a
			 * genuine next page, so it renders the same rows twice; this flag
			 * is what lets it start again from the top instead.
			 *
			 * It comes with an empty `items`, `hasMore: false` and no
			 * `nextCursor`, and it is never true for a request that carried no
			 * cursor.
			 */
			cursorStale: result.cursorStale,
			/**
			 * What age removed FROM THE DEFAULT VIEW, in every view. Non-zero is
			 * the page's cue to offer a way in — without it, age hiding is
			 * indistinguishable from a silent delete — and the way in is
			 * `view: "ageHidden"`, which returns exactly this many rows.
			 * Measuring it per view instead would make the same list report two
			 * different numbers depending on which scope the reader was in.
			 */
			ageHiddenCount: result.ageHiddenCount,
			ageThresholdDays: TODO_AGE_THRESHOLD_DAYS,
			/**
			 * Which projects' Unassigned bucket opens expanded for this viewer.
			 * Returned here so the client renders that default without a second
			 * call; the bucket is openable on every accessible project either
			 * way.
			 */
			unassignedExpandedProjectIds:
				visibility.unassignedExpandedProjectIds,
		};
	});
