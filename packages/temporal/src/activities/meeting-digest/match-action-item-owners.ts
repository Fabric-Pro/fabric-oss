/**
 * Meeting Digest — turn one meeting's action items into to-do rows and guess
 * their owners (Fizzy #2340).
 *
 * Runs after `extractMeetingInsightsActivity` has committed a transcript's
 * `ProjectMeetingActionItem` rows, and is what puts those commitments on the
 * consolidated To Do list. It creates a to-do per live item, keeps the ones
 * that already exist, and assigns an owner only when the transcript's guess is
 * unambiguous.
 *
 * Why a separate activity in a separate workflow, rather than a step appended
 * to extraction: adding an activity call to an existing workflow changes its
 * command sequence and breaks replay of in-flight executions (TMPRL1100)
 * unless gated behind `patched()` — the reasoning `link-meeting-action-items.ts`
 * beside this file already wrote down. There is also no single extraction
 * workflow: `extractMeetingInsightsActivity` runs from
 * `extractMeetingInsightsOnDemandWorkflow` AND from
 * `dailyBriefGenerationWorkflow`, so a matcher bolted onto one path would
 * produce nothing for meetings extracted through the other. The extraction
 * activity therefore starts `matchMeetingActionItemOwnersWorkflow`
 * fire-and-forget, the way `meeting-transcript-sync.ts` starts its siblings.
 *
 * The only owner signal available is `tentativeOwnerName`, a free-text guess an
 * LLM read off the transcript. Teams and Graph transcripts carry no participant
 * email, so there is nothing to join on and no identity to verify. That is why
 * this activity assigns ONLY on an exact normalized full-name match against
 * exactly one candidate, and why every weaker overlap — a shared first name, a
 * substring — becomes a suggestion a person confirms rather than a fact the
 * product asserts. Assigning "Sam" to the wrong Sam is worse than assigning
 * nobody: the item leaves the Unassigned bucket, nobody is looking for it, and
 * the person who actually owes it never sees it.
 *
 * Two invariants keep re-extraction from destroying human work. A row with
 * `assignedManually` is never re-assigned, re-suggested or cleared by this
 * activity — the person decided, and the matcher's guess does not outrank that.
 * And a to-do whose key addresses nothing live is RETAINED with its binding
 * intact, its assignment moved into the suggestion fields so the page can offer
 * it back; deleting it, or nulling its key, is what would let a reworded item
 * silently destroy a PM's tracking.
 *
 * Idempotence is structural, not incidental: every live item is written through
 * an upsert on `(transcriptId, itemKey, occurrenceIndex)`, and every write is
 * skipped outright when the row already holds what this run would write. A
 * Temporal retry, or a second run over unchanged text, therefore issues no
 * database writes at all.
 */

import {
	type BindableActionItem,
	type BindableTodo,
	bindActionItemsToTodos,
	db,
	isFeatureEnabled,
	normalizeItemText,
	Prisma,
	TODO_BINDING_VERSION,
	todoBindingWhere,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";

const LOG_PREFIX = "[MeetingDigest/matchActionItemOwners]";

/** Heartbeat cadence through the write loop. */
const HEARTBEAT_EVERY_ITEMS = 25;

/**
 * One person the matcher could not rule out, stored on
 * `TodoItem.suggestionCandidates` so the page can render a confirm control per
 * name without re-deriving the match.
 *
 * The name is denormalized deliberately: the row has to stay readable after a
 * member leaves the organization or a contact is redacted, exactly as
 * `itemTextSnapshot` keeps the item readable after a rewording.
 */
export interface TodoSuggestionCandidate {
	kind: "user" | "contact";
	id: string;
	name: string;
}

export interface MatchMeetingActionItemOwnersInput {
	projectId: string;
	/**
	 * Required. An absent organization is a resolution bug in the caller, not a
	 * personal-scope run: this activity refuses rather than falling back to a
	 * session, a global lookup or the null tenant arm, because every candidate
	 * query below is scoped by it and an unscoped one would offer a same-named
	 * person from another organization as an owner.
	 */
	organizationId: string | null;
	transcriptCuid: string;
}

export interface MatchMeetingActionItemOwnersOutput {
	itemsConsidered: number;
	todosCreated: number;
	todosUpdated: number;
	/** Stored to-dos whose key addressed nothing live in this run. */
	todosOrphaned: number;
	/** Items this run assigned an owner to outright. */
	assigned: number;
	/** Items left unassigned with at least one candidate recorded. */
	suggested: number;
	/** Non-null when the run deliberately wrote nothing. */
	skipped: "flag-off" | "unchanged" | null;
}

/** The to-do columns this activity reads before deciding whether to write. */
interface MatchableTodo extends BindableTodo {
	id: string;
	itemKey: string | null;
	occurrenceIndex: number | null;
	projectId: string | null;
	itemTextSnapshot: string | null;
	sourceDate: Date;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	assignedManually: boolean;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	suggestionCandidates: unknown;
}

/** A live action item, in the shape the binding helper needs plus the guess. */
type LiveActionItem = BindableActionItem & {
	tentativeOwnerName: string | null;
	/**
	 * The item's OWN stored key, which is not the key this activity derives from
	 * its text. Items extracted before #2340 added the column carry null here,
	 * and the read's `live_action_item` CTE discards a null-keyed row — so the
	 * key has to be written back before a to-do binds to one. Read to decide
	 * whether that write is needed; never read to bind.
	 */
	itemKey: string | null;
};

/** One live item paired with the stored row it binds to, if there is one. */
interface LiveEntry {
	item: LiveActionItem;
	itemKey: string;
	occurrenceIndex: number;
	todo: MatchableTodo | null;
}

/** Exactly the columns this activity owns on a meeting-sourced to-do. */
interface DesiredTodoState {
	projectId: string;
	itemTextSnapshot: string;
	sourceDate: Date;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	suggestionCandidates: TodoSuggestionCandidate[] | null;
}

interface OwnerVerdict {
	assignee: TodoSuggestionCandidate | null;
	suggestion: TodoSuggestionCandidate | null;
	candidates: TodoSuggestionCandidate[];
}

const NO_OWNER: OwnerVerdict = {
	assignee: null,
	suggestion: null,
	candidates: [],
};

/**
 * Two names overlap when they share a whole token, or when one is a substring
 * of the other.
 *
 * This is the SUGGESTION rule, never the assignment rule — it is deliberately
 * generous, because its only consequence is that a name appears on a chip a
 * person may click. "Sam" against "Sam Carter" shares a token; "Ann" against
 * "Joanna Reed" is caught by containment. Both stay unassigned.
 */
function namesOverlap(owner: string, candidate: string): boolean {
	if (owner.length === 0 || candidate.length === 0) {
		return false;
	}
	const ownerTokens = owner.split(" ");
	const candidateTokens = candidate.split(" ");
	if (ownerTokens.some((token) => candidateTokens.includes(token))) {
		return true;
	}
	return candidate.includes(owner) || owner.includes(candidate);
}

/**
 * Stable ordering so the stored JSON is byte-identical across runs — which is
 * what lets the change detector below treat an unchanged run as a no-op instead
 * of rewriting the same candidates in a different order every time.
 */
function sortCandidates(
	candidates: readonly TodoSuggestionCandidate[],
): TodoSuggestionCandidate[] {
	return [...candidates].sort(
		(a, b) =>
			a.kind.localeCompare(b.kind) ||
			a.name.localeCompare(b.name) ||
			a.id.localeCompare(b.id),
	);
}

/**
 * Decides what a transcript's free-text owner guess is worth.
 *
 * Members and contacts are one pool on purpose: a client-side stakeholder with
 * no Fabric account is as much an owner as an employee, and an item that
 * matched a member's name exactly is NOT unambiguous if a contact carries the
 * same name. Ambiguity anywhere in that pool means nobody is assigned.
 */
function resolveOwnerVerdict(
	tentativeOwnerName: string | null,
	candidates: readonly TodoSuggestionCandidate[],
): OwnerVerdict {
	const owner = normalizeItemText(tentativeOwnerName ?? "");
	if (owner.length === 0) {
		return NO_OWNER;
	}

	const exact = candidates.filter(
		(candidate) => normalizeItemText(candidate.name) === owner,
	);
	if (exact.length === 1) {
		return { assignee: exact[0], suggestion: null, candidates: [] };
	}
	if (exact.length > 1) {
		// Two people genuinely carry this name. Picking either would be a coin
		// flip presented as a fact, so both are offered and neither is applied.
		return {
			assignee: null,
			suggestion: null,
			candidates: sortCandidates(exact),
		};
	}

	const weak = candidates.filter((candidate) =>
		namesOverlap(owner, normalizeItemText(candidate.name)),
	);
	if (weak.length === 0) {
		return NO_OWNER;
	}
	return {
		// A single weak candidate is pointed at so the page can render a
		// one-click confirm, but it is still only a suggestion: the assignee
		// columns stay null and the item stays in the Unassigned bucket.
		assignee: null,
		suggestion: weak.length === 1 ? weak[0] : null,
		candidates: sortCandidates(weak),
	};
}

function assigneeColumns(candidate: TodoSuggestionCandidate | null): {
	userId: string | null;
	contactId: string | null;
} {
	if (!candidate) {
		return { userId: null, contactId: null };
	}
	return candidate.kind === "user"
		? { userId: candidate.id, contactId: null }
		: { userId: null, contactId: candidate.id };
}

/**
 * True when the stored row already holds every column this run would write.
 *
 * Dates compare by instant and the candidate JSON by its canonical
 * serialization, because Prisma hands both back as new objects on every read.
 */
function todoNeedsWrite(
	current: MatchableTodo,
	desired: DesiredTodoState,
): boolean {
	return (
		current.projectId !== desired.projectId ||
		current.itemTextSnapshot !== desired.itemTextSnapshot ||
		current.sourceDate.getTime() !== desired.sourceDate.getTime() ||
		current.assigneeUserId !== desired.assigneeUserId ||
		current.assigneeContactId !== desired.assigneeContactId ||
		current.suggestedUserId !== desired.suggestedUserId ||
		current.suggestedContactId !== desired.suggestedContactId ||
		JSON.stringify(current.suggestionCandidates ?? null) !==
			JSON.stringify(desired.suggestionCandidates ?? null)
	);
}

/**
 * The columns a manual assignment freezes.
 *
 * A person who picked an assignee also implicitly resolved every suggestion
 * beside it, so the matcher leaves the whole cluster alone rather than
 * re-decorating a settled row with fresh guesses on every re-extraction.
 */
function frozenAssignment(
	todo: MatchableTodo,
): Pick<
	DesiredTodoState,
	| "assigneeUserId"
	| "assigneeContactId"
	| "suggestedUserId"
	| "suggestedContactId"
	| "suggestionCandidates"
> {
	return {
		assigneeUserId: todo.assigneeUserId,
		assigneeContactId: todo.assigneeContactId,
		suggestedUserId: todo.suggestedUserId,
		suggestedContactId: todo.suggestedContactId,
		suggestionCandidates: todo.suggestionCandidates as
			| TodoSuggestionCandidate[]
			| null,
	};
}

export async function matchMeetingActionItemOwnersActivity(
	input: MatchMeetingActionItemOwnersInput,
): Promise<MatchMeetingActionItemOwnersOutput> {
	const { projectId, organizationId, transcriptCuid } = input;

	// Refuse BEFORE the gate read, which is itself organization-scoped. There is
	// no fallback arm to reach for: an unscoped candidate query would put a
	// same-named person from a different organization in front of a PM as
	// someone to assign work to.
	if (!organizationId) {
		throw ApplicationFailure.nonRetryable(
			`${LOG_PREFIX} refusing to match without an organizationId (transcript ${transcriptCuid})`,
			"TenantViolation",
		);
	}

	// Rollout gate, not a kill switch: off means the capability is absent, so
	// nothing is written and no row is left half-populated for the page to find
	// if the gate later opens.
	if (!(await isFeatureEnabled("TODO_LIST", organizationId))) {
		return emptyResult("flag-off");
	}

	heartbeat("matchActionItemOwners: loading meeting");

	// Scoped by project AND by the project's organization, mirroring the
	// extraction activity: a transcript cuid from another tenant must be
	// unfindable here, not merely unauthorized somewhere upstream.
	const transcript = await db.projectMeetingTranscript.findFirst({
		where: { id: transcriptCuid, projectId, project: { organizationId } },
		select: {
			id: true,
			projectId: true,
			meetingDate: true,
			syncedAt: true,
			userId: true,
			organizationId: true,
			// The revision this run is about to act on. The stamp at the end is
			// conditioned on it, so a re-extraction that lands mid-run cannot be
			// reported as matched by a run that never saw its items.
			insightsExtractedAt: true,
			actionItems: {
				select: {
					id: true,
					orderIndex: true,
					text: true,
					completedAt: true,
					tentativeOwnerName: true,
					itemKey: true,
				},
				orderBy: { orderIndex: "asc" },
			},
			todoItems: {
				select: {
					id: true,
					itemKey: true,
					occurrenceIndex: true,
					projectId: true,
					itemTextSnapshot: true,
					sourceDate: true,
					assigneeUserId: true,
					assigneeContactId: true,
					assignedManually: true,
					suggestedUserId: true,
					suggestedContactId: true,
					suggestionCandidates: true,
				},
			},
		},
	});
	if (!transcript) {
		throw new Error(
			`${LOG_PREFIX} transcript ${transcriptCuid} not found in project ${projectId}`,
		);
	}

	// A meeting with no date still needs one: `sourceDate` drives both the age
	// clock and the recency ordering on the To Do page, and a null there would
	// make the row unsortable. Ingest time is the closest honest stand-in.
	const sourceDate = transcript.meetingDate ?? transcript.syncedAt;

	const binding = bindActionItemsToTodos<LiveActionItem, MatchableTodo>({
		actionItems: transcript.actionItems,
		todos: transcript.todoItems,
	});

	// One list rather than two loops: an item with a to-do and an item without
	// one differ only in whether there is a row to compare against, and the
	// upsert below addresses both through the same binding triple. Sorted back
	// into meeting order so a run's writes — and its logs — are deterministic.
	const live: LiveEntry[] = [
		...binding.matched.map((entry) => ({
			item: entry.item,
			itemKey: entry.itemKey,
			occurrenceIndex: entry.occurrenceIndex,
			todo: entry.todo as MatchableTodo | null,
		})),
		...binding.unmatched.map((entry) => ({
			item: entry.item,
			itemKey: entry.itemKey,
			occurrenceIndex: entry.occurrenceIndex,
			todo: null,
		})),
	].sort(
		(a, b) =>
			a.item.orderIndex - b.item.orderIndex ||
			a.occurrenceIndex - b.occurrenceIndex,
	);

	// Give every live item its own stored key BEFORE a to-do binds to one.
	//
	// #2340 added `itemKey` to project_meeting_action_item as a nullable column
	// with no backfill, reasoning that the extraction row builder fills it from
	// this same helper going forward. That reasoning held only while nothing
	// reached the meetings extracted before the column existed. `todos.catchUp`
	// reaches exactly those. Without this pass a historical meeting produces
	// to-dos whose key is right while the action item beside them still says
	// null, and `listVisibleTodos` requires `a."itemKey" IS NOT NULL` to join the
	// two: the row renders as orphaned work, an item completed months ago comes
	// back open, and completing it from the page moves the to-do without moving
	// the digest. The stamp at the end of this activity would then shut the door,
	// because catch-up only selects transcripts it has never stamped.
	//
	// Guarded on `itemKey: null` rather than written unconditionally. A non-null
	// key was computed by extraction from the same text through the same helper,
	// so overwriting it is either a no-op or a TODO_BINDING_VERSION change — and
	// a version change is a migration that recomputes every key (see
	// `bind-action-items.ts`), never a silent per-row rewrite from here. The same
	// guard is what makes a Temporal retry idempotent and what lets a concurrent
	// extraction's fresh key win over this repair instead of losing to it.
	let keysBackfilled = 0;
	for (const entry of live) {
		if (entry.item.itemKey !== null) {
			continue;
		}
		const { count } = await db.projectMeetingActionItem.updateMany({
			where: { id: entry.item.id, organizationId, itemKey: null },
			data: { itemKey: entry.itemKey },
		});
		keysBackfilled += count;
	}

	const candidates = await loadOwnerCandidates(organizationId);

	let todosCreated = 0;
	let todosUpdated = 0;
	let assigned = 0;
	let suggested = 0;
	let assignmentsRefused = 0;

	for (const [index, entry] of live.entries()) {
		if (index % HEARTBEAT_EVERY_ITEMS === 0) {
			heartbeat(
				`matchActionItemOwners: item ${index + 1}/${live.length}`,
			);
		}

		const existing = entry.todo;
		const verdict = resolveOwnerVerdict(
			entry.item.tentativeOwnerName,
			candidates,
		);
		const assigneeCols = assigneeColumns(verdict.assignee);
		const suggestionCols = assigneeColumns(verdict.suggestion);

		const desired: DesiredTodoState = {
			projectId: transcript.projectId,
			itemTextSnapshot: entry.item.text,
			sourceDate,
			...(existing?.assignedManually
				? frozenAssignment(existing)
				: {
						assigneeUserId: assigneeCols.userId,
						assigneeContactId: assigneeCols.contactId,
						suggestedUserId: suggestionCols.userId,
						suggestedContactId: suggestionCols.contactId,
						suggestionCandidates:
							verdict.candidates.length > 0
								? verdict.candidates
								: null,
					}),
		};

		if (existing && !todoNeedsWrite(existing, desired)) {
			continue;
		}

		const candidatesJson = toJsonColumn(desired.suggestionCandidates);

		// The columns this activity owns split into two groups with different
		// concurrency rules, which is why they are written by two statements
		// instead of one. The source group restates what the meeting says and is
		// always safe to write. The assignment group is a person's territory, and
		// the `assignedManually` value that decided it came from the snapshot
		// loaded at the top of this activity — before candidate resolution, which
		// is the slowest thing here. A person can confirm a suggestion inside that
		// window. A single combined write would overwrite their choice AND leave
		// `assignedManually` true, freezing the matcher's guess in place as though
		// they had chosen it themselves.
		const sourceColumns = {
			projectId: desired.projectId,
			itemTextSnapshot: desired.itemTextSnapshot,
			sourceDate: desired.sourceDate,
		};
		const assignmentColumns = {
			assigneeUserId: desired.assigneeUserId,
			assigneeContactId: desired.assigneeContactId,
			suggestedUserId: desired.suggestedUserId,
			suggestedContactId: desired.suggestedContactId,
			suggestionCandidates: candidatesJson,
		};

		// Upsert rather than create-or-update-by-id: a Temporal retry that lost
		// its answer halfway through must land on the same row, and the compound
		// unique is the only address that survives extraction deleting and
		// recreating the action item rows underneath it.
		await db.todoItem.upsert({
			where: todoBindingWhere(transcript.id, entry),
			create: {
				source: "MEETING_DIGEST",
				transcriptId: transcript.id,
				itemKey: entry.itemKey,
				occurrenceIndex: entry.occurrenceIndex,
				userId: transcript.userId,
				// The activity's own validated input, not the transcript's
				// nullable column. A to-do written with a null tenant matches
				// neither `listVisibleTodos` nor `loadTodoForMutation`: it would
				// hold the unique binding slot forever while being invisible and
				// unwritable, and the activity would report it as created.
				organizationId: transcript.organizationId ?? organizationId,
				...sourceColumns,
				...assignmentColumns,
			},
			update: sourceColumns,
		});

		// Re-checked by Postgres in the WHERE, not in JavaScript against the
		// snapshot: this predicate is the only thing standing between a person's
		// confirmation and this run's guess, so it has to be evaluated at write
		// time. A frozen row is skipped outright rather than rewritten with its
		// own values — writing a snapshot back is exactly how a stale read turns
		// itself into a fact.
		const assignmentApplied = existing?.assignedManually
			? 0
			: (
					await db.todoItem.updateMany({
						where: {
							transcriptId: transcript.id,
							itemKey: entry.itemKey,
							occurrenceIndex: entry.occurrenceIndex,
							organizationId,
							assignedManually: false,
						},
						data: assignmentColumns,
					})
				).count;

		// Counted from what the guarded write MATCHED, not from the verdict this
		// run computed. Those were the same number until the guard existed; now
		// a person confirming a suggestion mid-run makes the write match nothing,
		// and a counter taken from the verdict would report an assignment that
		// never happened. `assigned` is the first number anyone checks when the
		// page looks wrong, so it has to mean rows, not intentions.
		if (assignmentApplied > 0) {
			if (verdict.assignee) {
				assigned += 1;
			} else if (verdict.candidates.length > 0) {
				suggested += 1;
			}
		} else if (!existing?.assignedManually) {
			// Distinguished from the frozen case above on purpose: a row that was
			// frozen when we read it is ordinary, while one that became frozen
			// between the read and the write is the race this guard exists for,
			// and it is worth being able to see in the logs.
			assignmentsRefused += 1;
		}

		if (existing) {
			todosUpdated += 1;
		} else {
			todosCreated += 1;
		}
	}

	const orphansRewritten = await carryOrphanedAssignments(
		binding.orphaned,
		candidates,
	);

	// Counts only — never item text or a person's name (worker-log redaction).
	logger.info(`${LOG_PREFIX} run complete`, {
		projectId,
		transcriptCuid,
		items: live.length,
		todosCreated,
		todosUpdated,
		todosOrphaned: binding.orphaned.length,
		orphansRewritten,
		assigned,
		suggested,
		candidates: candidates.length,
		// Non-zero when a person claimed a row between this run's read and its
		// write. Expected to be 0 almost always; a number that stops being 0 is
		// the signal that the matcher is racing real people.
		assignmentsRefused,
		// Non-zero only on a meeting extracted before #2340 added the column.
		// Worth its own number: a support question about a historical meeting
		// looking orphaned is answered by whether this repair ran for it.
		keysBackfilled,
	});

	const wroteNothing =
		todosCreated === 0 && todosUpdated === 0 && orphansRewritten === 0;

	// #2340. Stamp last, so a run that throws part-way leaves the transcript
	// looking unmatched and the catch-up path picks it up again. Versioned on
	// TODO_BINDING_VERSION: moving that constant re-keys every binding, so every
	// stamp taken under the old version must stop counting as done.
	//
	// Conditioned on the extraction revision this run actually read. Re-extraction
	// deletes and recreates the action items and clears this stamp in ONE
	// transaction, then starts the matcher again — and that start is refused while
	// this run is still RUNNING. Without the condition the sequence is: this run
	// reads extraction A; extraction B commits its items and clears the stamp; B's
	// matcher start is rejected; this run then stamps the transcript current having
	// never seen B's items. `todos.catchUp` selects on an unset or superseded
	// stamp, so it would not schedule B either, and B's commitments would stay
	// missing until some later extraction happened to run. Leaving the transcript
	// unmatched is the honest outcome: it costs one more matcher run and keeps the
	// meeting inside catch-up's reach.
	const { count: stamped } = await db.projectMeetingTranscript.updateMany({
		where: {
			id: transcript.id,
			insightsExtractedAt: transcript.insightsExtractedAt,
		},
		data: {
			todosMatchedAt: new Date(),
			todoMatchVersion: TODO_BINDING_VERSION,
		},
	});

	if (stamped === 0) {
		// `count === 0` is every reason the WHERE failed collapsed into one
		// number, so it is resolved rather than guessed at. Both reasons mean the
		// same thing for the write — do not stamp — but they mean different
		// things to whoever reads the log, and a line that asserts "superseded"
		// when the transcript was deleted is a wrong answer dressed as a fact.
		const current = await db.projectMeetingTranscript.findUnique({
			where: { id: transcript.id },
			select: { insightsExtractedAt: true },
		});
		// Not an error either way: the to-dos this run wrote are correct for the
		// items it saw. Only the claim "this transcript is matched" is withheld.
		logger.info(`${LOG_PREFIX} stamp declined`, {
			projectId,
			transcriptCuid,
			reason: current ? "re-extracted-mid-run" : "transcript-gone",
		});
	}

	return {
		itemsConsidered: live.length,
		todosCreated,
		todosUpdated,
		todosOrphaned: binding.orphaned.length,
		assigned,
		suggested,
		skipped: wroteNothing ? "unchanged" : null,
	};
}

/**
 * Members and contacts of ONE organization, as a single pool of possible owners.
 *
 * Both queries carry `organizationId` in the WHERE rather than filtering after
 * the fact, so a same-named contact in another organization is not merely
 * ranked lower — it is never read. Redacted contacts are excluded: a tombstone
 * is not a person anyone should be offered as an owner.
 */
async function loadOwnerCandidates(
	organizationId: string,
): Promise<TodoSuggestionCandidate[]> {
	const [members, contacts] = await Promise.all([
		db.member.findMany({
			where: { organizationId },
			select: { user: { select: { id: true, name: true } } },
		}),
		db.nonMemberContact.findMany({
			where: { organizationId, redactedAt: null },
			select: { id: true, name: true },
		}),
	]);

	return [
		...members.map(
			(member): TodoSuggestionCandidate => ({
				kind: "user",
				id: member.user.id,
				name: member.user.name,
			}),
		),
		...contacts.map(
			(contact): TodoSuggestionCandidate => ({
				kind: "contact",
				id: contact.id,
				name: contact.name,
			}),
		),
	];
}

/**
 * Keeps a rewritten item's tracking alive.
 *
 * An orphan is a to-do whose key addresses nothing in this run — a reworded
 * item, a dropped one, or a surplus duplicate. It is retained, and its
 * assignment is moved into the suggestion fields so the page can offer the same
 * person back with one click. Nothing is deleted and the binding columns are
 * deliberately left in place: they are the row's address, and a wording that
 * reverts (or a re-extraction that produces the original text again) then
 * re-matches this very row and restores its history, which nulling the key
 * would make impossible.
 *
 * A manually assigned orphan is skipped entirely. R5's guarantee — a person's
 * choice survives every run — cannot have an exception here, or confirming a
 * suggestion on an orphan would simply be undone by the next extraction.
 */
async function carryOrphanedAssignments(
	orphaned: readonly MatchableTodo[],
	candidates: readonly TodoSuggestionCandidate[],
): Promise<number> {
	let rewritten = 0;

	for (const todo of orphaned) {
		if (todo.assignedManually) {
			continue;
		}
		if (!todo.assigneeUserId && !todo.assigneeContactId) {
			// Nothing to carry: an unassigned orphan keeps whatever suggestion it
			// already had rather than being rewritten to say the same thing.
			continue;
		}

		const former =
			candidates.find(
				(candidate) =>
					(candidate.kind === "user" &&
						candidate.id === todo.assigneeUserId) ||
					(candidate.kind === "contact" &&
						candidate.id === todo.assigneeContactId),
			) ?? null;

		// Guarded in the WHERE for the reason the main loop is: the
		// `assignedManually` check above read a snapshot taken before candidate
		// resolution, and a person can confirm this very orphan inside that
		// window. Moving their assignee into the suggestion fields would read to
		// them as the product quietly un-assigning work they had just taken.
		const { count } = await db.todoItem.updateMany({
			where: { id: todo.id, assignedManually: false },
			data: {
				assigneeUserId: null,
				assigneeContactId: null,
				suggestedUserId: todo.assigneeUserId,
				suggestedContactId: todo.assigneeContactId,
				// Resolvable means the person is still in the organization, so the
				// chip gets a name. When they are not, the stored candidates are
				// left untouched rather than replaced with an empty list — the
				// suggested id still points somewhere the page can resolve.
				...(former
					? {
							suggestionCandidates: toJsonColumn([former]),
						}
					: {}),
			},
		});
		rewritten += count;
	}

	return rewritten;
}

/**
 * Prisma refuses a bare `null` on a nullable Json column because it cannot tell
 * "store JSON null" from "clear the column"; `Prisma.DbNull` is the second.
 */
function toJsonColumn(
	candidates: TodoSuggestionCandidate[] | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
	return candidates === null
		? Prisma.DbNull
		: (candidates as unknown as Prisma.InputJsonValue);
}

function emptyResult(
	skipped: MatchMeetingActionItemOwnersOutput["skipped"],
): MatchMeetingActionItemOwnersOutput {
	return {
		itemsConsidered: 0,
		todosCreated: 0,
		todosUpdated: 0,
		todosOrphaned: 0,
		assigned: 0,
		suggested: 0,
		skipped,
	};
}
