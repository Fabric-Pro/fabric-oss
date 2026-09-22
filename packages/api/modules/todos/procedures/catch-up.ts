/**
 * Catching up the meetings the owner matcher never ran for (Fizzy #2340).
 *
 * WHY THIS EXISTS. The live path starts
 * `matchMeetingActionItemOwnersWorkflow` from inside
 * `extractMeetingInsightsActivity`, the moment a transcript's insights commit.
 * That path is fire-and-forget and it misses three whole classes of meeting,
 * every one of them silently:
 *
 *  1. **Everything that predates the gate.** `TODO_LIST` is a rollout gate, and
 *     turning it on for an organization does not re-extract anything —
 *     extraction short-circuits on `insightsExtractedAt` plus its version, so a
 *     meeting analyzed last month never re-extracts and therefore never
 *     re-starts the matcher. Without this procedure, an organization that
 *     enables the feature today opens the To Do page onto nothing and has no
 *     way to tell that from a broken page.
 *  2. **A Temporal blip.** `getTemporalClient()` throwing during a daily brief
 *     is caught and logged at `warn` by the extraction activity, which then
 *     reports success. That meeting's to-dos would never be written at all.
 *  3. **A start rejected by the conflict policy.** The extraction site uses
 *     `workflowIdConflictPolicy: "FAIL"`, so a re-extraction landing while the
 *     previous run for the same transcript is still RUNNING is rejected — and
 *     swallowed by the same catch.
 *
 * The state that makes all three recoverable was already being written and was
 * read by nothing: `ProjectMeetingTranscript.todosMatchedAt` and
 * `.todoMatchVersion` are stamped by the matcher activity on success and
 * cleared by extraction when it rewrites the action items. This procedure is
 * their reader — the query below is what turns two dead columns into a cursor.
 *
 * SHAPED AFTER `projects/procedures/meeting-digest/link-action-items.ts`,
 * which does exactly this for the linking feature and is called from the
 * meeting digest page on open. The differences are the two that follow from
 * the To Do page being ORGANIZATION-level rather than meeting-level: there is
 * no `projectId` in the input for `requireProjectPermission` to authorize
 * against, and one call covers many meetings rather than one — so this needs
 * the project-access predicate and a cap, and that one does not.
 *
 * AUTHORIZATION IS IN TWO HALVES, as it is in `list.ts` and
 * `pending-proposals.ts`. The declared gate
 * (`requireInputOrgPermission(TODO_READ, { requireOrganization: true })`)
 * proves membership of the organization NAMED IN THE INPUT and nothing more;
 * `requireOrganization: true` is mandatory, because without it an explicit
 * `organizationId: null` resolves to nothing and skips the role check
 * entirely. The second half is `organizationProjectWhere` from
 * `../lib/visibility.ts` — the tenant-scoping predicate. Membership of the
 * organization is NOT enough to start work for a project: a guest invited to
 * one project must not be able to spend the queue on the other forty, nor
 * learn from a count that they exist.
 *
 * AND IT STAYS THE WIDE PREDICATE — A CHOICE, NOT AN OMISSION (#2615). Every
 * other surface that took the wide rule moved to `openableProjectWhere`,
 * because each of them was handing back a project a reader could then be sent
 * to. This one is different in the only way that matters: it RETURNS NO
 * PROJECT DATA. The response carries three counts — candidates, started,
 * failed — and one boolean, `hasMore`. Not a name, not a meeting, not an id,
 * not a link: nothing a caller could learn a project from, and therefore no
 * disclosure for the strict rule to close. `projectId` IS read inside the
 * handler, to build the workflow start arguments, and never reaches the
 * response. Counts of the caller's OWN tenant, bounded by the wide predicate,
 * are what they already know by being a member.
 *
 * What narrowing would cost is real. This is the repair path for meetings that
 * predate the rollout, and the matcher it starts writes to-dos for the people
 * the meeting named — who are drawn from the whole organization
 * (`match-action-item-owners.ts`, `loadOwnerCandidates`) and need not be
 * members of the project. Under the strict rule a meeting would only ever be
 * caught up if someone who is the project's creator or an accepted member
 * happened to open the To Do page; an organization whose projects are
 * administered by one person and worked by many would leave most of its
 * meetings unprocessed indefinitely, and the symptom — an empty list — is
 * indistinguishable from a broken one. Nothing here is offered to the caller,
 * so nothing here needs the link rule.
 *
 * READ PERMISSION FOR SOMETHING THAT STARTS WORKFLOWS, deliberately, for the
 * reason `linkActionItemsProcedure` records about `PROJECT_READ`: the page is
 * a read surface for every member and it self-populates on first open, so a
 * write permission here would mean the list stays empty for exactly the people
 * who are only allowed to look at it. Nothing this starts writes anything the
 * caller could not already have read — the matcher derives to-dos from action
 * items of meetings in their own projects — which is also why there is no
 * audit action: no security-relevant state changes here.
 *
 * NOT AUDITED, NOT FATAL, NOT AWAITED BEYOND THE START. A failed start is
 * counted and reported, never thrown: the page that called this is showing a
 * list, and failing its load because a background matcher could not be queued
 * would turn a partial list into no list at all.
 */

import { TODO_BINDING_VERSION, db } from "@repo/database";
import { logger } from "@repo/logs";
import {
	MEETING_TODO_MATCHER_TASK_QUEUE,
	meetingTodoMatcherWorkflowId,
} from "@repo/temporal/meeting-todo-matcher";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireTodoListEnabled } from "../lib/mutation-access";
import { organizationProjectWhere } from "../lib/visibility";
import { requireOrganizationContext } from "./contacts/shared";

/**
 * How many matcher runs ONE call may start.
 *
 * The number has to hold two things apart. A page open must never fan out
 * proportionally to the tenant's history — an organization with a thousand
 * unmatched meetings would otherwise queue a thousand workflows from a single
 * load, on `project-documents`, the queue the meeting digest's linking
 * workflow and the document workflows share. That is the failure this cap
 * exists for, and it argues for a small number.
 *
 * Against that, the cap decides how fast a backlog drains, because it drains
 * one page-open at a time. Twenty-five is chosen because it is the size of
 * burst a worker fleet absorbs without a visible queue delay for interactive
 * work, while being more meetings than an organization of any size holds
 * unmatched in ordinary running: the live extraction path keeps up, so a
 * backlog this deep means the gate was just switched on, or Temporal was down.
 * Both are one-off situations that a handful of opens clears.
 *
 * It is a constant and not an input: a client-chosen cap is not a cap.
 */
export const TODO_CATCH_UP_MAX_STARTS = 25;

export const todoCatchUpInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
});

/** What one call did, in counts the absence of to-dos can be diagnosed from. */
export interface TodoCatchUpResult {
	/**
	 * Transcripts selected by this call — meetings of the caller's projects
	 * that have action items and are unmatched or matched at a superseded
	 * binding version. Never more than {@link TODO_CATCH_UP_MAX_STARTS}.
	 */
	candidates: number;
	/** Of those, the starts that were accepted (or already running). */
	started: number;
	/** Of those, the starts that threw. These meetings stay candidates. */
	failed: number;
	/**
	 * Whether the cap truncated the selection, i.e. another call would find
	 * more. The page can say "still catching up" instead of "nothing here".
	 */
	hasMore: boolean;
}

export const catchUpTodosProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos/catch-up",
		tags: ["Todos"],
		summary: "Start the owner matcher for meetings it never ran for",
		description:
			"Finds meetings in the caller's reachable projects that have action items but no current owner match, and starts the matcher for them. Fire-and-forget: it reports what it queued, not what it produced — to-dos appear as each run finishes. Bounded per call and ordered newest meeting first, so a long history drains over several calls.",
	})
	.input(todoCatchUpInputSchema)
	.handler(async ({ input, context }): Promise<TodoCatchUpResult> => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		// One clock for the whole request, for the reason every other to-do
		// procedure takes one: the membership-expiry arm of the project
		// predicate must not disagree with itself inside a single request.
		const now = new Date();

		const candidates = await db.projectMeetingTranscript.findMany({
			where: {
				organizationId,
				// The access boundary. Not `{ organizationId }` alone: an
				// organization member does not necessarily reach every project
				// of it, and an invited project guest reaches exactly one.
				//
				// DELIBERATELY THE WIDE PREDICATE — see the header. This
				// procedure returns counts and no project data, so it is not a
				// disclosure; the strict rule would instead leave a meeting
				// uncaught-up until one of the few people who can OPEN its
				// project happened to visit, while the people the meeting
				// actually named waited on an empty page.
				project: organizationProjectWhere(
					context.user.id,
					organizationId,
					now,
				),
				// Nothing to match. Checked here rather than left to the
				// activity so an organization whose meetings are all
				// status-only does not queue a workflow per meeting to
				// discover it. Mirrors the `actionItemCount === 0` guard in
				// `link-action-items.ts`.
				actionItems: { some: {} },
				OR: [
					// Never matched — the gate-was-just-opened case, and the
					// case where extraction cleared the stamp and its own start
					// then failed.
					{ todosMatchedAt: null },
					// Matched under a superseded binding version, so the
					// `itemKey`s the to-dos were bound by no longer agree with
					// the ones the digest computes.
					//
					// Spelled as two arms because `not` over a nullable column
					// is exactly the kind of NULL semantics that differs
					// between a Prisma version and the SQL a reader expects. A
					// row stamped at no version at all is stale by the same
					// reasoning and is stated, not inferred.
					{ todoMatchVersion: null },
					{ todoMatchVersion: { not: TODO_BINDING_VERSION } },
				],
			},
			select: { id: true, projectId: true },
			// Deterministic, and newest first on purpose. The cap means a
			// backlog is drained over several calls, so the ORDER decides what
			// a person sees first, and the meetings they are looking for are
			// the recent ones. `id` breaks ties so the page order of two
			// meetings on the same date cannot shuffle between calls; without
			// it a tie at the cap boundary could hand back a different row each
			// time and stall on the same few. Undated rows sort last rather
			// than first, which is where Postgres would otherwise put them
			// under DESC.
			orderBy: [
				{ meetingDate: { sort: "desc", nulls: "last" } },
				{ id: "asc" },
			],
			// One more than the cap, purely to answer `hasMore` without a
			// second count query over the same predicate.
			take: TODO_CATCH_UP_MAX_STARTS + 1,
		});

		const hasMore = candidates.length > TODO_CATCH_UP_MAX_STARTS;
		const selected = hasMore
			? candidates.slice(0, TODO_CATCH_UP_MAX_STARTS)
			: candidates;

		if (selected.length === 0) {
			return { candidates: 0, started: 0, failed: 0, hasMore: false };
		}

		// Dynamic import keeps @repo/temporal's client out of the API's static
		// graph, exactly as `link-action-items.ts` does. The id builder above
		// is a separate, import-free module for the same reason.
		let client: Awaited<
			ReturnType<typeof import("@repo/temporal")["getTemporalClient"]>
		>;
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			client = await getTemporalClient();
		} catch (err) {
			// Temporal unreachable. This is failure class 2 from the header,
			// happening to the catch-up itself — report it as every start
			// having failed rather than failing the caller's page load. The
			// transcripts stay unmatched, so the next open tries again.
			logger.warn("[todos.catchUp] Temporal client unavailable", {
				organizationId,
				candidates: selected.length,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				candidates: selected.length,
				started: 0,
				failed: selected.length,
				hasMore,
			};
		}

		const outcomes = await Promise.all(
			selected.map(async (transcript) => {
				try {
					await client.workflow.start(
						"matchMeetingActionItemOwnersWorkflow",
						withCorrelationMemo({
							taskQueue: MEETING_TODO_MATCHER_TASK_QUEUE,
							// The SAME id the extraction path uses, from the
							// same builder, so a run already in flight from a
							// brief that just finished is joined rather than
							// duplicated.
							workflowId: meetingTodoMatcherWorkflowId(
								transcript.id,
							),
							// ALLOW_DUPLICATE governs CLOSED runs: a previous
							// run that finished before a version bump (or
							// before a re-extraction) must be startable again,
							// or a stale stamp could never be refreshed.
							workflowIdReusePolicy: "ALLOW_DUPLICATE",
							// USE_EXISTING, and NOT the extraction site's FAIL.
							// The policies differ because the question does.
							// There, a start is a claim that new items were
							// just written and a collision is worth surfacing.
							// Here, a run already in flight is precisely the
							// outcome wanted — the to-dos are being written —
							// and the page is about to poll for them. FAIL
							// would turn the ordinary case (two members opening
							// the page at once; an open racing a daily brief)
							// into an exception per meeting, which the only
							// honest report would then have to translate back
							// into success by matching on
							// `WorkflowExecutionAlreadyStartedError`'s name.
							// Saying USE_EXISTING states that directly and
							// keeps `failed` meaning the one thing worth
							// paging on: this meeting will NOT be caught up.
							workflowIdConflictPolicy: "USE_EXISTING",
							args: [
								{
									projectId: transcript.projectId,
									organizationId,
									transcriptCuid: transcript.id,
								},
							],
						}),
					);
					return true;
				} catch (err) {
					// Per transcript, so one unstartable meeting does not stop
					// the other twenty-four. It stays a candidate and the next
					// open retries it.
					logger.warn("[todos.catchUp] Failed to start the matcher", {
						organizationId,
						transcriptCuid: transcript.id,
						error: err instanceof Error ? err.message : String(err),
					});
					return false;
				}
			}),
		);

		const started = outcomes.filter(Boolean).length;
		return {
			candidates: selected.length,
			started,
			failed: selected.length - started,
			hasMore,
		};
	});
