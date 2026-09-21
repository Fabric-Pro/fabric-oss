import type { useFormatter } from "next-intl";
/**
 * What the To Do list shows, and the pure rules that shape it (Fizzy #2340).
 *
 * Everything here is a function of the ONE response `todos.list` returns, and
 * nothing here re-derives a decision the server already made. Two of those
 * decisions are easy to re-implement by accident and must not be:
 *
 *  - WHICH UNASSIGNED BUCKETS OPEN. `unassignedExpandedProjectIds` arrives in
 *    the response because the rule behind it (product owner, product
 *    contributor, or an administrator of a project nobody has tagged) is a
 *    server-side reading of function tags and project roles. The client reads
 *    the list; it does not ask "is this viewer a PO" again.
 *  - WHAT A ROW SAYS. An orphaned row's `title` is ALREADY the stored snapshot
 *    — the server prefers the bound action item's live wording and falls back
 *    to the snapshot when the binding no longer resolves. The page renders
 *    `title` and explains the fallback; it never picks between the two.
 *
 * WHY THE TYPES ARE RESTATED HERE. The page consumes the procedure's inferred
 * response, so this is deliberately a STRUCTURAL SUBSET of that DTO: every
 * field below exists on it with the same type, which is what lets the inferred
 * value be passed straight in. The meeting fields are the exception and are
 * optional — see `TodoListItem`.
 */

import { addDays, addMonths } from "date-fns";

/**
 * One person the owner matcher could not rule out, as the row offers them.
 *
 * The matcher denormalizes the NAME into `TodoItem.suggestionCandidates`
 * (see `match-action-item-owners.ts`) so a shortlist stays readable after a
 * member leaves or a contact is redacted. That is why the confirm chip can name
 * a person the response never hydrated: the name travelled with the guess.
 */
export interface TodoSuggestionCandidate {
	kind: "user" | "contact";
	id: string;
	name: string;
}

/** One row of the list, as the page reads it. */
export interface TodoListItem {
	id: string;
	source: "MEETING_DIGEST" | "MANUAL";
	/** Live wording, or the stored snapshot once the row is orphaned. */
	title: string;
	projectId: string | null;
	projectName: string | null;
	assigneeUserId: string | null;
	assigneeUser: { id: string; name: string; image: string | null } | null;
	assigneeContactId: string | null;
	assigneeContact: { id: string; name: string } | null;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	assignedManually: boolean;
	snoozedUntil: string | null;
	/** The one date the row shows: the meeting's date, or when it was written. */
	sourceDate: string;
	completedAt: string | null;
	isCompleted: boolean;
	/** The row's meeting was re-extracted and its wording no longer resolves. */
	isOrphaned: boolean;
	/**
	 * THE MATCHER'S SHORTLIST — `unknown` ON PURPOSE.
	 *
	 * The column is Json and `todos.list` projects it as `unknown`, so this
	 * field is declared with the SAME width rather than a narrower one: a
	 * narrower declaration would stop the inferred response being assignable
	 * here, and would also quietly promise that whatever a past extraction
	 * wrote still parses. Read it through `parseSuggestionCandidates`, which
	 * keeps the rows a malformed entry would otherwise take down.
	 */
	suggestionCandidates?: unknown;
	/**
	 * The completion the row cached before a rewording orphaned its binding.
	 *
	 * Written only for a MEETING-SOURCED row, and cleared when the person
	 * reopens it, so a non-null value on a row that is not currently completed
	 * means exactly one thing: this was done, and then the wording changed
	 * underneath it. That is the note the row shows.
	 */
	lastKnownCompletedAt?: string | null;
	/**
	 * The free-text owner the transcript named — a guess, never an assignment.
	 *
	 * OPTIONAL BECAUSE THE READ DOES NOT PROJECT IT YET. It lives on the live
	 * `ProjectMeetingActionItem`, and it is what seeds a new contact's name
	 * when the matcher shortlisted nobody: the person whose name was said out
	 * loud is exactly the contact the register is missing. Until the read
	 * returns it the create dialog simply opens empty.
	 */
	tentativeOwnerName?: string | null;
	/**
	 * THE MEETING LINK — OPTIONAL ON PURPOSE.
	 *
	 * `todos.list` does not project these yet: its DTO carries `source` but not
	 * the graph transcript ref, the item key or the meeting's name, so a
	 * meeting-sourced row cannot be addressed from here today. They are
	 * declared optional so this page renders the link and the exact meeting
	 * grouping the moment the read returns them, and degrades to grouping by
	 * the shared meeting date until it does (every row of one meeting carries
	 * the same `sourceDate`).
	 *
	 * `meetingTranscriptRef` is the GRAPH transcript id that
	 * `buildDigestDeepLink` and `meetingDigest.getMeeting` accept — never the
	 * transcript row's cuid. `meetingItemKey` is the durable item key, not an
	 * action item row id, because those are recreated on every extraction.
	 */
	meetingTranscriptRef?: string | null;
	meetingItemKey?: string | null;
	meetingTitle?: string | null;
}

/** The slice of the response the list body needs. */
export interface TodoListData {
	items: TodoListItem[];
	ageHiddenCount: number;
	ageThresholdDays: number;
	unassignedExpandedProjectIds: string[];
}

/** The fixed view scope — the only filter with a bounded set of values. */
export type TodoScope = "open" | "completed" | "snoozed";

export const TODO_SCOPES: readonly TodoScope[] = [
	"open",
	"completed",
	"snoozed",
];

/** A project the loaded rows mention. */
export interface TodoProjectOption {
	id: string;
	name: string;
}

/** A person the loaded rows are assigned to — a member or a contact. */
export interface TodoAssigneeOption {
	kind: "user" | "contact";
	id: string;
	name: string;
}

export interface TodoFilters {
	scope: TodoScope;
	project: TodoProjectOption | null;
	assignee: TodoAssigneeOption | null;
}

/**
 * The same two narrowing filters, as the READ takes them (Fizzy #2340).
 *
 * Project and assignee are arguments to `todos.list`, not a sieve over its
 * answer. The list is keyset-paged, so a browser-side narrowing can only ever
 * describe the pages that happen to be loaded: "filter by Apollo" over the
 * first fifty rows shows nothing when Apollo's work starts at row fifty-one,
 * while the control above the list claims to be filtering the workspace.
 * Sending them lets the server answer the question the reader actually asked,
 * and the page starts a fresh page-1 read when either one changes.
 *
 * At most ONE assignee key is ever set: a to-do carries `assigneeUserId` XOR
 * `assigneeContactId`, and the read REFUSES both at once (they could only match
 * nothing). One combobox holding one selection is what makes that safe.
 */
export interface TodoServerFilters {
	projectId?: string;
	assigneeUserId?: string;
	assigneeContactId?: string;
}

/** The filter bar's selections, as the read's input. */
export function todoServerFilters(
	project: TodoProjectOption | null,
	assignee: TodoAssigneeOption | null,
): TodoServerFilters {
	return {
		...(project ? { projectId: project.id } : {}),
		...(assignee?.kind === "user" ? { assigneeUserId: assignee.id } : {}),
		...(assignee?.kind === "contact"
			? { assigneeContactId: assignee.id }
			: {}),
	};
}

/**
 * ONE ROW PER ID, whatever the pages say — the FIRST copy wins.
 *
 * The page is keyset-paged over a live list, so two fetches can overlap: a row
 * whose sort key moved between them is served again under the next cursor. An
 * appended duplicate is not cosmetic — it is a repeated React key, a row that
 * renders twice with two sets of actions, and an Unassigned bucket that counts
 * the same to-do twice. Keeping the first copy keeps the order the reader has
 * been reading. `TodoAgeHiddenView` does the same for the same reason.
 *
 * Generic over the row so the procedure's inferred response flows through
 * unchanged — `TodoListItem` is a structural subset of it.
 */
export function dedupeTodos<TItem extends { id: string }>(
	items: TItem[],
): TItem[] {
	const byId = new Map<string, TItem>();
	for (const item of items) {
		if (!byId.has(item.id)) {
			byId.set(item.id, item);
		}
	}
	return [...byId.values()];
}

/**
 * Still asleep at `nowMs`.
 *
 * The boundary is exclusive, matching the read's own `snoozedUntil <= now`:
 * a snooze whose deadline has exactly arrived has elapsed.
 */
export function isSnoozed(item: TodoListItem, nowMs: number): boolean {
	if (!item.snoozedUntil) {
		return false;
	}
	const wakeAt = Date.parse(item.snoozedUntil);
	return Number.isFinite(wakeAt) && wakeAt > nowMs;
}

/**
 * Which of the three views a row belongs to.
 *
 * Completion wins over snooze: a row someone completed while it slept is done,
 * and listing it under Snoozed would offer to wake work that no longer exists.
 */
export function todoScope(item: TodoListItem, nowMs: number): TodoScope {
	if (item.isCompleted) {
		return "completed";
	}
	return isSnoozed(item, nowMs) ? "snoozed" : "open";
}

export function isUnassigned(item: TodoListItem): boolean {
	return item.assigneeUserId === null && item.assigneeContactId === null;
}

/**
 * Whether the name on the row is a SUGGESTION rather than a decision.
 *
 * A row nobody confirmed still shows who the extraction thought was on the
 * hook. Saying so is the difference between "you owe this" and "a model thinks
 * you might" — and an orphan, whose wording has already changed underneath it,
 * is never more than the second.
 */
export function isSuggestedAssignment(item: TodoListItem): boolean {
	if (isUnassigned(item) || item.assignedManually) {
		return false;
	}
	return (
		item.isOrphaned ||
		item.suggestedUserId !== null ||
		item.suggestedContactId !== null
	);
}

/**
 * The project and assignee narrowing, WITHOUT the scope.
 *
 * Split out because a row completed in this session stays in the open view
 * (see `visibleTodos`) and must still obey the filters the reader set: staying
 * put is about the scope alone, and a row that ignored the project chip above
 * it would look like the filter had stopped working.
 */
export function matchesNarrowingFilters(
	item: TodoListItem,
	filters: TodoFilters,
): boolean {
	if (filters.project && item.projectId !== filters.project.id) {
		return false;
	}
	if (filters.assignee) {
		const matchesAssignee =
			filters.assignee.kind === "user"
				? item.assigneeUserId === filters.assignee.id
				: item.assigneeContactId === filters.assignee.id;
		if (!matchesAssignee) {
			return false;
		}
	}
	return true;
}

export function matchesFilters(
	item: TodoListItem,
	filters: TodoFilters,
	nowMs: number,
): boolean {
	if (todoScope(item, nowMs) !== filters.scope) {
		return false;
	}
	return matchesNarrowingFilters(item, filters);
}

/**
 * What the current view shows — including the rows completed IN THIS SESSION.
 *
 * Ticking something off must not make it vanish under the cursor. A row that
 * disappears the instant it is completed gives the person no way to see that
 * the right one was ticked, and no way to take it back except by changing the
 * view; worse, the next row slides under the pointer and gets the second click
 * of a double-click. So a completed row stays where it was for the rest of the
 * session, struck through and still reopenable.
 *
 * `justCompletedIds` comes from the module's QUERY CACHE rather than from this
 * component's state, so walking into a meeting digest and back does not erase
 * it. A full reload does — and should: the server keeps the two most recently
 * completed rows in the default read, which is the durable version of the same
 * promise.
 */
export function visibleTodos(
	items: TodoListItem[],
	filters: TodoFilters,
	nowMs: number,
	justCompletedIds: ReadonlySet<string>,
): TodoListItem[] {
	return items.filter(
		(item) =>
			matchesFilters(item, filters, nowMs) ||
			(filters.scope === "open" &&
				item.isCompleted &&
				justCompletedIds.has(item.id) &&
				// A row that was snoozed as well belongs to the snoozed view;
				// pinning it open would show work that is deliberately hidden.
				!isSnoozed(item, nowMs) &&
				matchesNarrowingFilters(item, filters)),
	);
}

/**
 * The matcher's shortlist, or nothing.
 *
 * The column is Json written by a Temporal activity over transcripts of any
 * age, so the page treats it as untrusted shape: an entry missing a name, an
 * older run's shape, or a bare string all yield no candidate rather than a
 * chip labelled `undefined` or a render that throws and takes the list with it.
 * Duplicates are collapsed on `kind:id` so one person cannot be offered twice.
 */
export function parseSuggestionCandidates(
	value: unknown,
): TodoSuggestionCandidate[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const candidates: TodoSuggestionCandidate[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const { kind, id, name } = entry as Record<string, unknown>;
		if (kind !== "user" && kind !== "contact") {
			continue;
		}
		if (typeof id !== "string" || id.length === 0) {
			continue;
		}
		if (typeof name !== "string" || name.trim().length === 0) {
			continue;
		}
		const key = `${kind}:${id}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		candidates.push({ kind, id, name });
	}
	return candidates;
}

/**
 * This was completed, and then the meeting's wording changed underneath it.
 *
 * `lastKnownCompletedAt` is written only when a meeting-sourced row is
 * completed and is CLEARED when it is reopened, so a non-null value on a row
 * that does not currently read as completed can only mean the binding stopped
 * resolving. Saying so is the difference between "you never did this" and "you
 * did this, and the item it was attached to was rewritten".
 *
 * That holds because BOTH surfaces that can complete the underlying action item
 * maintain the snapshot: this page (`setTodoCompletion`) and the meeting digest
 * (`setActionItemCompletion`), each in the same transaction as the completion
 * itself. A writer that skipped it would make this function claim a completion
 * that was taken back, or deny one that happened.
 */
export function wasPreviouslyCompleted(item: TodoListItem): boolean {
	return !item.isCompleted && Boolean(item.lastKnownCompletedAt);
}

/**
 * What a row action asserts about a row before the server has answered.
 *
 * Every key is one a mutation in this module writes, and only those: an
 * override is a claim about the outcome of a call in flight, not a second
 * place the row is edited. It is released once the refetched response carries
 * the same fact (or, on failure, the original one) — see `useTodoRowActions`.
 */
export interface TodoOverride {
	isCompleted?: boolean;
	completedAt?: string | null;
	snoozedUntil?: string | null;
	assigneeUserId?: string | null;
	assigneeUser?: TodoListItem["assigneeUser"];
	assigneeContactId?: string | null;
	assigneeContact?: TodoListItem["assigneeContact"];
	assignedManually?: boolean;
	suggestedUserId?: string | null;
	suggestedContactId?: string | null;
	suggestionCandidates?: unknown;
}

export function applyTodoOverride(
	item: TodoListItem,
	override: TodoOverride | undefined,
): TodoListItem {
	return override ? { ...item, ...override } : item;
}

/** How far out the snooze menu offers to push something. */
export type TodoSnoozePreset = "day" | "week" | "month";

export const TODO_SNOOZE_PRESETS: readonly TodoSnoozePreset[] = [
	"day",
	"week",
	"month",
];

/**
 * When a preset wakes a row.
 *
 * Calendar arithmetic, not multiplication: a month is not thirty days and a
 * day is not always 24 hours — across a DST boundary `now + 86_400_000` lands
 * an hour off, which is how "tomorrow" becomes "late tonight". `date-fns`
 * handles both, and the result is always strictly after `from`, which is what
 * `todos.snooze` requires of the date it is sent.
 */
export function snoozePresetDate(preset: TodoSnoozePreset, from: Date): Date {
	switch (preset) {
		case "day":
			return addDays(from, 1);
		case "week":
			return addDays(from, 7);
		default:
			return addMonths(from, 1);
	}
}

/**
 * The projects THIS response mentions, in first-appearance order.
 *
 * Derived from the rows rather than fetched, so the combobox never offers a
 * project the reader has no to-do in. It is not the whole option set on its
 * own: the selection is sent to the read, so while a filter is on the response
 * only contains rows that match it — see `rememberOptions`, which is what keeps
 * the other projects on offer.
 */
export function projectOptions(items: TodoListItem[]): TodoProjectOption[] {
	const seen = new Map<string, TodoProjectOption>();
	for (const item of items) {
		if (item.projectId && item.projectName && !seen.has(item.projectId)) {
			seen.set(item.projectId, {
				id: item.projectId,
				name: item.projectName,
			});
		}
	}
	return [...seen.values()];
}

/** Stable identity of an assignee option — ids collide across the two kinds. */
export function assigneeOptionKey(option: TodoAssigneeOption): string {
	return `${option.kind}:${option.id}`;
}

/**
 * Every option the reader has been offered so far, not only this response's.
 *
 * WHY THE OPTION SET CANNOT SIMPLY BE "WHAT IS LOADED". The two narrowing
 * filters are sent to the read, so while one is on, the response holds only
 * rows that match it. Re-derived fresh each time, the project combobox would
 * collapse to the one project already selected and the reader could not move to
 * another without first clearing the filter — and paging would make the set
 * flicker as each page arrived. So the set only ever GROWS: an option that was
 * offered once stays offered, across pages and across scope switches, and the
 * read is what decides whether anything comes back for it.
 *
 * The map is the caller's, held for the life of the page.
 */
export function rememberOptions<TOption>(
	seen: Map<string, TOption>,
	options: TOption[],
	key: (option: TOption) => string,
): TOption[] {
	for (const option of options) {
		const id = key(option);
		if (!seen.has(id)) {
			seen.set(id, option);
		}
	}
	return [...seen.values()];
}

/** The people THIS response is assigned to, members and contacts alike. */
export function assigneeOptions(items: TodoListItem[]): TodoAssigneeOption[] {
	const seen = new Map<string, TodoAssigneeOption>();
	for (const item of items) {
		if (item.assigneeUser) {
			const key = `user:${item.assigneeUser.id}`;
			if (!seen.has(key)) {
				seen.set(key, {
					kind: "user",
					id: item.assigneeUser.id,
					name: item.assigneeUser.name,
				});
			}
			continue;
		}
		if (item.assigneeContact) {
			const key = `contact:${item.assigneeContact.id}`;
			if (!seen.has(key)) {
				seen.set(key, {
					kind: "contact",
					id: item.assigneeContact.id,
					name: item.assigneeContact.name,
				});
			}
		}
	}
	return [...seen.values()];
}

/**
 * A run of rows that share an origin: one meeting, or the hand-written rows of
 * one project.
 *
 * The meeting grouping is structural, not decorative: a later unit hangs the
 * per-meeting "proposals pending" indicator off the group header, which needs
 * a header to hang from.
 */
export interface TodoGroup {
	key: string;
	kind: "meeting" | "manual";
	meetingTitle: string | null;
	meetingTranscriptRef: string | null;
	projectId: string | null;
	projectName: string | null;
	/** Every row of one meeting shares this date; a manual group shows none. */
	sourceDate: string;
	items: TodoListItem[];
}

/**
 * Group assigned rows, preserving the server's ordering.
 *
 * Groups appear in the order their first row does, and rows keep their order
 * inside a group, so the age/recency ranking the read applied survives here.
 */
export function groupTodos(items: TodoListItem[]): TodoGroup[] {
	const groups: TodoGroup[] = [];
	const byKey = new Map<string, TodoGroup>();

	for (const item of items) {
		const project = item.projectId ?? "-";
		// Until the read projects the transcript ref, the meeting's date is the
		// grouping key: the rows of one meeting all carry that meeting's
		// timestamp, so this separates meetings within a project correctly and
		// only ever merges two meetings that started at the same instant.
		const key =
			item.source === "MEETING_DIGEST"
				? `meeting:${project}:${item.meetingTranscriptRef ?? item.sourceDate}`
				: `manual:${project}`;

		const existing = byKey.get(key);
		if (existing) {
			existing.items.push(item);
			continue;
		}

		const group: TodoGroup = {
			key,
			kind: item.source === "MEETING_DIGEST" ? "meeting" : "manual",
			meetingTitle: item.meetingTitle ?? null,
			meetingTranscriptRef: item.meetingTranscriptRef ?? null,
			projectId: item.projectId,
			projectName: item.projectName,
			sourceDate: item.sourceDate,
			items: [item],
		};
		byKey.set(key, group);
		groups.push(group);
	}

	return groups;
}

/** One project's pile of work nobody owns yet. */
export interface TodoUnassignedBucket {
	key: string;
	projectId: string | null;
	projectName: string | null;
	/** The SERVER's answer, read as given. Anyone may still open the bucket. */
	expandedByDefault: boolean;
	items: TodoListItem[];
}

export function groupUnassigned(
	items: TodoListItem[],
	expandedProjectIds: string[],
): TodoUnassignedBucket[] {
	const expanded = new Set(expandedProjectIds);
	const buckets: TodoUnassignedBucket[] = [];
	const byKey = new Map<string, TodoUnassignedBucket>();

	for (const item of items) {
		const key = item.projectId ?? "";
		const existing = byKey.get(key);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		const bucket: TodoUnassignedBucket = {
			key,
			projectId: item.projectId,
			projectName: item.projectName,
			// A row with no project cannot be in the server's list, so it stays
			// closed: "expanded" is a statement about a project's owner.
			expandedByDefault:
				item.projectId !== null && expanded.has(item.projectId),
			items: [item],
		};
		byKey.set(key, bucket);
		buckets.push(bucket);
	}

	return buckets;
}

/**
 * One date format for the whole To Do surface (Fizzy #2340).
 *
 * The list body, the row and the age-hidden view each render dates, and each
 * had its own identical copy of this closure — three places a format change
 * would have had to land, and two places it could have been forgotten. The
 * formatter is passed in rather than captured so this stays a pure function and
 * each component keeps its own `useFormatter()` instance.
 */
export function formatTodoDate(
	formatter: ReturnType<typeof useFormatter>,
	value: string,
): string {
	return formatter.dateTime(new Date(value), {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}
