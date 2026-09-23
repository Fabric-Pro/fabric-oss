/**
 * The consolidated To Do list's single organization-level read (#2340).
 *
 * One statement serves the whole page. That is a deliberate constraint rather
 * than an optimisation: every rule the page applies — snooze, the age clock,
 * the ten-row floor, the completion window, paging and the count of what age
 * hid — has to agree with every other one, and the only way to guarantee that
 * is to evaluate them over the same set in the same pass. Applying any of them
 * after the fetch silently breaks paging, because a page of 20 that loses 6
 * rows in application code is a page of 14 with a cursor that skips the 6.
 *
 * WHY RAW SQL. Completion of a meeting-sourced to-do lives on
 * `ProjectMeetingActionItem`, not on the to-do (see `TodoItem`'s `///`
 * docblock), and the two are bound by `(transcriptId, itemKey,
 * occurrenceIndex)`. `occurrenceIndex` is a POSITION among the items of one
 * transcript that share a key, so the join needs a window function — there is
 * no Prisma relation that can express it, and no `include` that can order or
 * filter by it. The alternative is loading every action item of every meeting
 * in scope and re-deriving the keys in JavaScript, which is exactly what
 * `ProjectMeetingActionItem.itemKey` was made a stored column to avoid.
 *
 * WHY THE VISIBILITY PREDICATE ARRIVES AS A PARAMETER. The rules about who may
 * see whose to-do are not a database concern and must not be restated here:
 * they live in one place, `packages/api/modules/todos/lib/visibility.ts`, and
 * every to-do read composes that one filter. This module receives it already
 * built, as a parameterised `Prisma.Sql` fragment, and is responsible only for
 * the mechanics around it. A second copy of those rules in this file is the
 * failure mode the single filter exists to prevent.
 *
 * WHY ONE `view` AND NOT A BOOLEAN PER RULE. The page offers four mutually
 * exclusive SCOPES — the working list, the completed archive, what is asleep,
 * and what age removed. Expressed as four independent flags they would admit
 * twelve combinations nobody has defined an answer for ("snoozed AND
 * age-hidden but not completed"), and each new surface would invent its own
 * reading of them. One enum has exactly as many states as the product has
 * views, so an undefined combination cannot be requested at all.
 *
 * WHY EVERY VIEW HANGS OFF `scoped`. The tenant equality, the caller's
 * visibility predicate and the project/assignee narrowing are applied ONCE, in
 * `scoped`, and all four views are derived from it. That placement is the
 * guarantee that "who may see this" is identical in every view: a view added
 * later cannot select from the table directly without also restating the
 * predicate, and a predicate restated is a predicate that drifts. What the
 * views differ in is only which of the already-visible rows they keep.
 *
 * WHY THE MEETING IS JOINED HERE. A meeting-sourced row has to name its
 * meeting and link back to that meeting's digest, and the to-do carries only
 * the transcript's cuid. Joining the transcript (and through it the linked
 * meeting whose subject the digest itself prefers) in this pass means the page
 * gets the same name the digest shows, the digest's own GRAPH transcript id
 * for its deep link, and an exact per-meeting grouping key — instead of
 * grouping rows by a shared `sourceDate`, which merges two meetings held the
 * same day and splits one whose date was corrected.
 *
 * WHY PAGING IS A KEYSET AND NOT A RANK. The next page is everything ordered
 * AFTER the cursor row's own position in the view's ORDER BY tuple, with `id`
 * as the tie-break that makes that tuple unique. It used to be a global
 * `ROW_NUMBER()` whose rank was looked up inside the very set being paged — and
 * that set is exactly what the page is built to change. See the comment above
 * `pageStart` below for what that cost, where a cursor's position is resolved
 * instead, and what `cursorStale` answers when it cannot be resolved at all.
 *
 * TENANCY. A raw query does not pass through the tenant extension in
 * `src/tenant-db.ts`, so the `organizationId` equality in the WHERE is the
 * whole tenant boundary and is never optional. The caller has already been
 * verified as a member of that organization by `requireInputOrgPermission`.
 */

import { db, Prisma } from "../../client";

/**
 * What `trim()` removes, spelled out for Postgres.
 *
 * One-argument `BTRIM` strips U+0020 and nothing else — a tab-only subject
 * would vanish in JS and survive here — so the whole ECMAScript whitespace set
 * is named. A `Prisma.sql` fragment with no parameters, composed rather than
 * interpolated, per this file's rule about text in SQL.
 *
 * FUNCTIONS, NOT CONSTANTS, and that is not style. A `const` here would call
 * `Prisma.sql` while this module is being imported, which makes merely
 * importing anything that reaches `queries/todos/index.ts` fail in any test
 * that mocks `@repo/database/prisma/client` without re-exporting `Prisma` —
 * a crash at import time, in files that never call this query. CI caught
 * exactly that. Keep every `Prisma.sql` in this file inside a function body.
 */
const trimChars = () =>
	Prisma.sql`E' \t\n\r\f\x0B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'`;

/** The occurrence's own subject, blank-normalised to NULL. */
const occurrenceSubject = () =>
	Prisma.sql`NULLIF(BTRIM(tr."meetingSubject", ${trimChars()}), '')`;

/** The recurring series' subject, blank-normalised to NULL. */
const seriesSubject = () =>
	Prisma.sql`NULLIF(BTRIM(lm."subject", ${trimChars()}), '')`;

/**
 * The four scopes the read answers for.
 *
 * Exported as a tuple so the procedure's input schema is built FROM it rather
 * than beside it: a fifth view added here is a type error at every `switch`
 * and a widened enum at the boundary, instead of a value the API accepts and
 * the SQL silently treats as the default.
 *
 *  - `default`    the working list: awake rows, every open one plus the
 *                 `recentCompletedLimit` most recently completed, with the age
 *                 cutoff and its recency floor applied.
 *  - `completed`  the archive: every completed row in scope, newest completion
 *                 first, with no age cutoff and no cap.
 *  - `snoozed`    what is still asleep, soonest to wake first.
 *  - `ageHidden`  exactly the rows the default view's age cutoff removed.
 */
export const TODO_LIST_VIEWS = [
	"default",
	"completed",
	"snoozed",
	"ageHidden",
] as const;

export type TodoListView = (typeof TODO_LIST_VIEWS)[number];

/**
 * A single row of the list, exactly as the SQL below projects it.
 *
 * Note what is absent: no threshold, floor or window constant is defined in
 * this file. All three arrive as parameters from
 * `packages/api/modules/todos/lib/visibility.ts`, which is where the product
 * rules are written; a default here would become a second answer to "how old
 * is too old" that nothing keeps in step with the first.
 */
export interface TodoListRow {
	id: string;
	source: "MEETING_DIGEST" | "MANUAL";
	/** The transcript ROW id (cuid) — the binding's own half, never a URL. */
	transcriptId: string | null;
	itemKey: string | null;
	occurrenceIndex: number | null;
	itemTextSnapshot: string | null;
	title: string | null;
	projectId: string | null;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	suggestionCandidates: unknown;
	assignedManually: boolean;
	snoozedUntil: Date | null;
	sourceDate: Date;
	lastKnownCompletedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	/** The later of `sourceDate` and an elapsed `snoozedUntil` — see below. */
	ageClock: Date;
	/** Completion as the action item holds it, or the row's own for a manual to-do. */
	effectiveCompletedAt: Date | null;
	/** A meeting-sourced row whose binding resolves to no live action item. */
	isOrphaned: boolean;
	/** The bound action item's current wording, or null when nothing is bound. */
	liveText: string | null;
	/** The extractor's free-text owner guess. A guess, never a fact. */
	tentativeOwnerName: string | null;
	/**
	 * `ProjectMeetingTranscript.transcriptId` — the GRAPH id, which is what the
	 * digest's deep link and `meetingDigest.getMeeting` accept. Deliberately a
	 * different column from `transcriptId` above, which is the row's cuid and
	 * addresses nothing outside the database.
	 */
	meetingTranscriptRef: string | null;
	/** The meeting's name, resolved exactly as the digest resolves it. */
	meetingTitle: string | null;
	/** When the meeting happened. Null on a transcript that never carried one. */
	meetingDate: Date | null;
}

export interface ListVisibleTodosParams {
	/** The whole tenant boundary for this read. Never optional. */
	organizationId: string;
	/**
	 * Who may see which row, built by
	 * `packages/api/modules/todos/lib/visibility.ts`. Parameterised
	 * (`Prisma.sql`), never interpolated text.
	 */
	visibilityCondition: Prisma.Sql;
	/**
	 * Which scope to return. Required rather than defaulted: the four views
	 * differ in which rows a user can reach at all, and a caller that forgot to
	 * say which one it meant would silently get the working list — the exact
	 * failure that left snoozed and age-hidden rows unreachable before.
	 */
	view: TodoListView;
	/** Narrow to one project. Combines with `assignee*` by AND. */
	projectId?: string;
	/** Narrow to one member. Mutually exclusive with `assigneeContactId`. */
	assigneeUserId?: string;
	/** Narrow to one non-member contact. */
	assigneeContactId?: string;
	/**
	 * The id of the last row of the previous page.
	 *
	 * The id alone, not an encoded position: the row's place in the view's
	 * ordering is resolved from `scoped`, which is every row this caller may
	 * see BEFORE any view narrows it — so a cursor row that has left the VIEW
	 * (completed, snoozed, aged out) still pages from the right place. When
	 * even `scoped` cannot place it, the read says so through `cursorStale`
	 * instead of quietly starting again.
	 */
	cursor?: string;
	limit: number;
	/**
	 * The clock, as a parameter. Both the snooze boundary and the age cutoff
	 * are derived from it, and neither is testable if this function reads
	 * `new Date()` itself — the same reason `isTopicSnoozed` in
	 * `src/publishing-inbox.ts` takes one.
	 */
	now: Date;
	ageThresholdDays: number;
	/** How many of the most recent rows survive the age cutoff regardless. */
	recencyFloor: number;
	/** How many completed rows the default view keeps. */
	recentCompletedLimit: number;
}

export interface ListVisibleTodosResult {
	rows: TodoListRow[];
	hasMore: boolean;
	nextCursor: string | null;
	/**
	 * How many otherwise-visible rows the age cutoff removed — measured over
	 * the DEFAULT view in every view, so the page can offer the way in from
	 * wherever the reader is standing and the number never contradicts itself
	 * between two scopes of the same list. It is also, exactly, how many rows
	 * the `ageHidden` view has to hand out.
	 */
	ageHiddenCount: number;
	/**
	 * The cursor named a row this read can no longer PLACE, so the page it was
	 * asked for does not exist: the row was deleted, this caller may no longer
	 * see it, or the column the view orders by has become null under it (a
	 * completed row reopened, a snooze cleared).
	 *
	 * True comes with an empty `rows`, `hasMore: false` and no `nextCursor`,
	 * and means "start again from the top" — never "there is nothing left".
	 * The distinction is the whole point: an appending client that is handed
	 * page one under a cursor cannot tell the two apart, and renders the same
	 * rows twice. False whenever no cursor was given at all.
	 */
	cursorStale: boolean;
}

/** Milliseconds in a day, for the age cutoff. */
const DAY_MS = 24 * 60 * 60 * 1000;

export async function listVisibleTodos(
	params: ListVisibleTodosParams,
): Promise<ListVisibleTodosResult> {
	const ageCutoff = new Date(
		params.now.getTime() - params.ageThresholdDays * DAY_MS,
	);

	const projectFilter = params.projectId
		? Prisma.sql`AND t."projectId" = ${params.projectId}`
		: Prisma.empty;

	// The two assignee filters are separate parameters rather than one tagged
	// union because a to-do carries `assigneeUserId` XOR `assigneeContactId`:
	// there is no column both can be compared against, and collapsing them
	// would mean re-deriving which one was meant inside the SQL.
	const assigneeFilter = params.assigneeUserId
		? Prisma.sql`AND t."assigneeUserId" = ${params.assigneeUserId}`
		: params.assigneeContactId
			? Prisma.sql`AND t."assigneeContactId" = ${params.assigneeContactId}`
			: Prisma.empty;

	// Which of the already-visible rows this view keeps, and in what order.
	// Every arm selects from `scoped` or from a CTE derived from it, so none of
	// them can widen who may see what — see the header.
	//
	// Each arm answers with THREE things that have to agree, so they are
	// written in one place: the rows, the column that orders them — aliased
	// `sortKey`, so the page's ORDER BY and the cursor comparison below can be
	// written once for all four views — and that same column as `scoped` holds
	// it, which is where a cursor's position is resolved. An arm that gave the
	// view one ordering and the cursor another would page in a sequence no
	// view uses, which is a duplicate-rows bug with nothing on screen to
	// suggest it.
	const paging = ((): {
		rows: Prisma.Sql;
		/** The ordering column as `scoped` holds it, for the cursor lookup. */
		cursorKey: Prisma.Sql;
		direction: "ASC" | "DESC";
	} => {
		switch (params.view) {
			case "completed":
				// The archive. No age cutoff and no cap: this view exists
				// because the default one keeps only the two most recent, and
				// re-applying either rule here would make the rest of the
				// history unreachable all over again. Snooze is deliberately
				// not consulted: completion wins over it, so a row someone
				// finished while it slept belongs here rather than waiting
				// behind a wake date nobody needs any more.
				return {
					rows: Prisma.sql`
			SELECT s.*, s."effectiveCompletedAt" AS "sortKey"
			FROM scoped s
			WHERE s."effectiveCompletedAt" IS NOT NULL`,
					cursorKey: Prisma.sql`s."effectiveCompletedAt"`,
					direction: "DESC",
				};
			case "snoozed":
				// The exact complement of `awake` below, against the same
				// clock: a row is either asleep here or ranked there, never
				// both and never neither. Ordered by wake date because the
				// question this view answers is "what comes back next", and
				// completed rows are excluded because there is no work left in
				// them to wake — the archive above is where they belong.
				return {
					rows: Prisma.sql`
			SELECT s.*, s."snoozedUntil" AS "sortKey"
			FROM scoped s
			WHERE s."snoozedUntil" IS NOT NULL
				AND s."snoozedUntil" > ${params.now}
				AND s."effectiveCompletedAt" IS NULL`,
					cursorKey: Prisma.sql`s."snoozedUntil"`,
					direction: "ASC",
				};
			case "ageHidden":
				// Precisely what the default view's cutoff removed: the same
				// set `hidden` counts, with the two predicates negated
				// together. Not "everything old" — a row inside the recency
				// floor is old and still kept, so hiding is the conjunction and
				// the complement has to be the conjunction's negation.
				return {
					rows: Prisma.sql`
			SELECT r.*, r."ageClock" AS "sortKey"
			FROM recency r
			WHERE r."ageClock" < ${ageCutoff}
				AND r."recencyRank" > ${params.recencyFloor}`,
					cursorKey: Prisma.sql`s."ageClock"`,
					direction: "DESC",
				};
			default:
				// At least the N most recent rows survive however old they are,
				// so an organization whose every to-do predates the threshold
				// still opens the page onto a list rather than onto nothing.
				return {
					rows: Prisma.sql`
			SELECT r.*, r."ageClock" AS "sortKey"
			FROM recency r
			WHERE r."ageClock" >= ${ageCutoff}
				OR r."recencyRank" <= ${params.recencyFloor}`,
					cursorKey: Prisma.sql`s."ageClock"`,
					direction: "DESC",
				};
		}
	})();

	// WHERE A PAGE STARTS, AND WHY IT IS NO LONGER A RANK.
	//
	// Paging is a KEYSET: the page is everything ordered AFTER the cursor row's
	// own position in this view's ordering, compared as the tuple
	// `(sortKey, id)` — `id` being the tie-break that makes the tuple unique,
	// without which two rows sharing a timestamp would be served twice or not
	// at all.
	//
	// It used to be a rank. The view was numbered with `ROW_NUMBER()` and the
	// cursor's rank was looked up INSIDE the view being paged — a set this page
	// exists to change. When the cursor row had left it the lookup found
	// nothing, `COALESCE(..., 0)` read that as rank zero, and the read answered
	// with PAGE ONE AGAIN, `hasMore` still true and the same `nextCursor`. For
	// a one-shot read that is a harmless degradation, and the old comment here
	// said so. For the one client that pages it is not: `TodoAgeHiddenView`
	// APPENDS pages, and its whole purpose is resolving rows out of this set,
	// so the cursor row disappearing between fetches is the NORMAL case. The
	// result was repeated ids, duplicate React keys, a select-all that counted
	// rows twice, and a "load more" that could be pressed for ever.
	//
	// So the position is resolved from `scoped` — every row this caller may
	// see, before any view's snooze, completion or age rules narrow it — and
	// never from `visible`. Completing a row, snoozing it or ageing it out
	// takes it out of a VIEW while leaving it in `scoped`, which is precisely
	// the bulk-resolve case, and it now keeps paging from exactly the right
	// place rather than restarting.
	//
	// When even `scoped` cannot place the cursor — the row was deleted, this
	// caller may no longer see it, or the column the view orders by went null
	// under it — the comparison is against NULL, which admits NO rows, and the
	// read reports `cursorStale`. An empty page plus a flag is the honest
	// answer: the client can start again from the top, which is the one thing
	// it could not do while the read pretended page one was page two.
	//
	// What a keyset still cannot decide is a cursor row whose sort key MOVED
	// rather than vanished (snoozing a row shifts its own age clock). Paging
	// then resumes from the row's new position and can repeat rows already
	// served — which is why `TodoAgeHiddenView` also deduplicates by id as it
	// flattens its pages. That client-side half is not belt-and-braces; it is
	// the half of the fix this statement cannot perform.
	const cursorId = params.cursor ?? null;
	const descending = paging.direction === "DESC";

	// No cursor is the first page: every row, ordered, limited. Written as an
	// explicit `TRUE` rather than a rank floor of zero so that "no cursor" and
	// "a cursor that resolved to nothing" cannot ever collapse into the same
	// predicate again.
	const pageStart =
		cursorId === null
			? Prisma.sql`TRUE`
			: descending
				? Prisma.sql`(v."sortKey", v.id) < ((SELECT c."sortKey" FROM cursor_row c), (SELECT c.id FROM cursor_row c))`
				: Prisma.sql`(v."sortKey", v.id) > ((SELECT c."sortKey" FROM cursor_row c), (SELECT c.id FROM cursor_row c))`;

	// The same tuple the cursor is compared on, in the same direction. The two
	// are built from one `direction` because an ORDER BY that disagreed with
	// the comparison would page through a sequence the reader never sees.
	const pageOrder = descending
		? Prisma.sql`ORDER BY v."sortKey" DESC NULLS LAST, v.id DESC NULLS LAST`
		: Prisma.sql`ORDER BY v."sortKey" ASC NULLS LAST, v.id ASC NULLS LAST`;

	const rows = await db.$queryRaw<
		Array<TodoListRow & { ageHiddenCount: number; cursorResolved: boolean }>
	>(Prisma.sql`
		WITH live_action_item AS (
			-- The other half of the binding. \`occurrenceIndex\` is a POSITION
			-- among the items of one transcript that normalize to the same key,
			-- assigned in ascending \`orderIndex\` — the identical rule
			-- \`bindActionItemsToTodos\` applies in TypeScript, and the reason
			-- this join cannot be a Prisma relation.
			SELECT
				a."transcriptId",
				a."itemKey",
				(
					ROW_NUMBER() OVER (
						PARTITION BY a."transcriptId", a."itemKey"
						ORDER BY a."orderIndex" ASC
					) - 1
				) AS "occurrenceIndex",
				a."completedAt",
				a."text",
				a."tentativeOwnerName"
			FROM "project_meeting_action_item" a
			WHERE a."organizationId" = ${params.organizationId}
				AND a."itemKey" IS NOT NULL
				-- Narrowed to the transcripts this organization actually has
				-- to-dos for. Without it every page load ranks every action item
				-- the organization has ever extracted. Whole transcripts are
				-- kept, never individual items, because a partial partition
				-- would shift the occurrence numbers the binding depends on.
				AND a."transcriptId" IN (
					SELECT DISTINCT b."transcriptId"
					FROM "todo_item" b
					WHERE b."organizationId" = ${params.organizationId}
						AND b."transcriptId" IS NOT NULL
				)
		),
		scoped AS (
			-- EVERY view starts here, and the tenant equality, the caller's
			-- visibility predicate and the two narrowing filters are applied
			-- exactly once, to this one set. Snooze, completion and age are
			-- NOT applied here: they are what the views differ in, and a rule
			-- applied at this depth would be a rule no view could ask back.
			SELECT
				t.id,
				t."source",
				t."transcriptId",
				t."itemKey",
				t."occurrenceIndex",
				t."itemTextSnapshot",
				t."title",
				t."projectId",
				t."assigneeUserId",
				t."assigneeContactId",
				t."suggestedUserId",
				t."suggestedContactId",
				t."suggestionCandidates",
				t."assignedManually",
				t."snoozedUntil",
				t."sourceDate",
				t."lastKnownCompletedAt",
				t."createdAt",
				t."updatedAt",
				-- The age clock runs from the later of the source date and any
				-- elapsed snooze. Without the second term, a to-do snoozed for a
				-- month on an already-old meeting returns and is age-hidden in
				-- the same instant, which reads as a silent delete. This mirrors
				-- \`topicLastActivityAt\` in src/publishing-inbox.ts, where the
				-- same requirement produced the same definition. GREATEST
				-- ignores NULL, so a never-snoozed row keeps its source date.
				GREATEST(t."sourceDate", t."snoozedUntil") AS "ageClock",
				-- A manual row carries its own completion. A BOUND meeting-sourced
				-- row carries none — the action item does, which is what keeps
				-- the digest and this list from ever disagreeing. An ORPHAN is
				-- the third case: its binding resolves to nothing live, so there
				-- is no action item to hold the completion and the row holds it
				-- itself. COALESCE covers all three without a second branch, and
				-- is safe for the bound case precisely because that invariant
				-- leaves \`t."completedAt"\` null there.
				CASE
					WHEN t."transcriptId" IS NULL THEN t."completedAt"
					ELSE COALESCE(ai."completedAt", t."completedAt")
				END AS "effectiveCompletedAt",
				(t."transcriptId" IS NOT NULL AND ai."itemKey" IS NULL)
					AS "isOrphaned",
				-- The live wording wins over the snapshot whenever the binding
				-- still resolves: the snapshot exists so an ORPHAN can still say
				-- what it was about, not so the list can show stale text beside
				-- a meeting that has been re-extracted since.
				ai."text" AS "liveText",
				-- The free-text owner the extractor guessed. Projected so an
				-- unassigned row can offer "add <name> as a contact and assign"
				-- without a second round trip; it is a guess, never a fact, and
				-- the page must present it as one.
				ai."tentativeOwnerName" AS "tentativeOwnerName",
				-- The meeting reference. \`tr."transcriptId"\` is the GRAPH id the
				-- digest is addressed by, NOT the cuid the to-do is bound on.
				--
				-- The title mirrors \`resolveMeetingDisplayName\`, which this query
				-- cannot call because it is raw SQL. Same four branches, same order:
				-- a usable occurrence subject, else a usable series name, else
				-- whichever placeholder is stored rather than no label at all.
				--
				-- "Untitled Meeting" counts as no name because the write path can
				-- never store a bare series name in its place, so letting the
				-- placeholder through would hide a real title behind it.
				--
				-- Keep the two in step. The digest resolves a meeting's name through
				-- that helper, and a user who follows a to-do to its meeting must
				-- arrive at the title they just clicked. A live parity test in
				-- \`packages/database/__tests__/todo-list-query.test.ts\` runs both
				-- sides over the same inputs and fails naming any that disagree.
				tr."transcriptId" AS "meetingTranscriptRef",
				COALESCE(
					NULLIF(${occurrenceSubject()}, 'Untitled Meeting'),
					NULLIF(${seriesSubject()}, 'Untitled Meeting'),
					${occurrenceSubject()},
					${seriesSubject()}
				) AS "meetingTitle",
				tr."meetingDate" AS "meetingDate"
			FROM "todo_item" t
			LEFT JOIN live_action_item ai
				ON ai."transcriptId" = t."transcriptId"
				AND ai."itemKey" = t."itemKey"
				AND ai."occurrenceIndex" = t."occurrenceIndex"
			-- Both joins are on primary keys reached THROUGH the to-do's own
			-- foreign key, so neither can multiply a row and neither can reach
			-- a meeting the row does not belong to. They add names only; no
			-- predicate below reads them.
			LEFT JOIN "project_meeting_transcript" tr
				ON tr."id" = t."transcriptId"
			LEFT JOIN "project_linked_meeting" lm
				ON lm."id" = tr."linkedMeetingId"
			WHERE t."organizationId" = ${params.organizationId}
				AND ${params.visibilityCondition}
				${projectFilter}
				${assigneeFilter}
		),
		awake AS (
			-- A snooze hides unconditionally and beats the recency floor.
			-- Excluding snoozed rows HERE, before anything is ranked, is what
			-- makes that precedence structural: a snoozed row cannot occupy one
			-- of the floor's slots and cannot be counted as hidden by age,
			-- because it never enters the set the default view is built from.
			-- The boundary is exclusive, so a snooze whose deadline has exactly
			-- arrived counts as elapsed — and the \`snoozed\` view above is this
			-- predicate negated against the same clock.
			SELECT s.*
			FROM scoped s
			WHERE s."snoozedUntil" IS NULL OR s."snoozedUntil" <= ${params.now}
		),
		ranked_completed AS (
			SELECT
				s.id,
				ROW_NUMBER() OVER (
					ORDER BY s."effectiveCompletedAt" DESC, s.id DESC
				) AS rn
			FROM awake s
			WHERE s."effectiveCompletedAt" IS NOT NULL
		),
		kept AS (
			-- The default view keeps every open row plus the N most recently
			-- completed, which is what makes "I just ticked that off"
			-- verifiable without turning the list into an archive. The rest of
			-- the history is the \`completed\` view's business.
			SELECT s.*
			FROM awake s
			LEFT JOIN ranked_completed rc ON rc.id = s.id
			WHERE s."effectiveCompletedAt" IS NULL
				OR rc.rn <= ${params.recentCompletedLimit}
		),
		recency AS (
			SELECT
				k.*,
				ROW_NUMBER() OVER (
					ORDER BY k."ageClock" DESC, k.id DESC
				) AS "recencyRank"
			FROM kept k
		),
		hidden AS (
			-- Computed over the default view's set in EVERY view, so the count
			-- means one thing wherever it is read, and so it matches the number
			-- of rows the \`ageHidden\` view hands back.
			SELECT COUNT(*)::int AS "ageHiddenCount"
			FROM recency r
			WHERE r."ageClock" < ${ageCutoff}
				AND r."recencyRank" > ${params.recencyFloor}
		),
		visible AS (${paging.rows}
		),
		cursor_row AS (
			-- The cursor row's POSITION, taken from \`scoped\` and not from
			-- \`visible\`: a row the page has just resolved, snoozed or aged out
			-- has left the view but not the set the visibility rules define,
			-- so its place in the ordering is still known. \`IS NOT NULL\` is
			-- load-bearing — a reopened row has no completion to order the
			-- archive by, and an unsnoozed one no wake date — and an unplaceable
			-- cursor must read as stale, never as position zero.
			SELECT ${paging.cursorKey} AS "sortKey", s.id
			FROM scoped s
			WHERE s.id = ${cursorId}::text
				AND ${paging.cursorKey} IS NOT NULL
		)
		-- \`hidden\` always yields exactly one row, so driving the join from it
		-- carries the count out even when the page itself is empty. A row with
		-- a NULL id is that empty page and is dropped below.
		--
		-- The columns are listed rather than \`v.*\` because \`recencyRank\` is a
		-- bigint that exists only to rank: selected, it would reach the API as a
		-- BigInt, which JSON cannot serialise. Listing them also keeps the two
		-- views that select from \`scoped\` (which has no \`recencyRank\` at all)
		-- projecting the same columns as the two that select from \`recency\`.
		SELECT
			h."ageHiddenCount",
			-- Whether the cursor could be placed at all. Carried on the count's
			-- own row, which always exists, so the answer survives the empty
			-- page a stale cursor produces — the case the client has to tell
			-- apart from "you have reached the end".
			(EXISTS (SELECT 1 FROM cursor_row)) AS "cursorResolved",
			v.id,
			v."source",
			v."transcriptId",
			v."itemKey",
			v."occurrenceIndex",
			v."itemTextSnapshot",
			v."title",
			v."projectId",
			v."assigneeUserId",
			v."assigneeContactId",
			v."suggestedUserId",
			v."suggestedContactId",
			v."suggestionCandidates",
			v."assignedManually",
			v."snoozedUntil",
			v."sourceDate",
			v."lastKnownCompletedAt",
			v."createdAt",
			v."updatedAt",
			v."ageClock",
			v."effectiveCompletedAt",
			v."isOrphaned",
			v."liveText",
			v."tentativeOwnerName",
			v."meetingTranscriptRef",
			v."meetingTitle",
			v."meetingDate"
		FROM hidden h
		LEFT JOIN visible v
			ON ${pageStart}
		${pageOrder}
		LIMIT ${params.limit + 1}
	`);

	const ageHiddenCount = rows[0]?.ageHiddenCount ?? 0;
	// `hidden` always yields exactly one row, so the flag is always there. The
	// fallback is the conservative one: an answer that could not be read is
	// treated as a cursor we failed to place, because carrying on regardless is
	// the failure this flag exists to end.
	const cursorStale = cursorId !== null && rows[0]?.cursorResolved !== true;
	const page = rows.filter((row) => row.id !== null);
	const hasMore = page.length > params.limit;
	const items = page.slice(0, params.limit);

	return {
		rows: items.map(
			({ ageHiddenCount: _count, cursorResolved: _resolved, ...row }) =>
				row,
		),
		hasMore,
		nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
		ageHiddenCount,
		cursorStale,
	};
}
