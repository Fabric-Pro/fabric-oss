/**
 * The personal-meeting transcript read, shared by getPersonalTranscript (which
 * shows it) and getPersonalInsights (which summarises it).
 *
 * Extracted rather than copied: this is the privacy-critical path, and two
 * divergent copies of a Graph chain that must never persist anything is exactly
 * the accident #1899's FR7 guard exists to prevent. It is covered by the same
 * source-level no-persistence guard as its callers
 * (apps/web/__tests__/api/meeting-digest/personal-no-persistence.test.ts).
 *
 * PRIVACY CONTRACT: transcript text returned here exists only for the lifetime
 * of the request. Never write it to the database, Redis, an embedding, a
 * Temporal workflow, or a log line.
 */
import { isMicrosoftNotConnectedError } from "@repo/integrations/microsoft";
import {
	isMeetingLookupForbiddenError,
	isMeetingNotFoundError,
} from "./microsoft-connection-error";
import { utcDayKey } from "./occurrence-day";

type TranscriptReason =
	| "no-transcript"
	| "admin-consent-required"
	| "transcript-access-disabled"
	| "not-connected"
	| "no-access"
	/**
	 * Graph cannot resolve an online meeting for this join URL — a calendar
	 * entry with no Teams meeting behind it, or one whose record is no longer
	 * retrievable. Distinct from `no-transcript` (the meeting resolved, it
	 * simply has no transcript yet) because the two send the user somewhere
	 * different, and distinct from `no-access` so we never call someone's own
	 * meeting a colleague's.
	 */
	| "meeting-not-found";

/**
 * Prefix of the `error` string `classifyTranscriptForbidden` returns for the
 * Teams tenant setting that blocks Graph transcript access outright
 * (packages/integrations/src/microsoft/index.ts).
 *
 * Matched here rather than imported so this privacy-critical module keeps its
 * only dependency the injected `callGraph` — the reason it is unit-testable
 * without standing up the Graph stack.
 *
 * That leaves the two literals coupled by convention alone, and a reworded
 * classifier would silently stop matching here: the UI would fall back to the
 * generic admin-consent copy with every test still green. Exported so
 * apps/web/__tests__/api/meeting-digest/transcript-access-disabled-prefix.test.ts
 * can assert the real classifier output still starts with it. Do not inline it.
 */
export const TRANSCRIPT_ACCESS_DISABLED_PREFIX =
	"Microsoft Graph access to meeting transcripts is disabled";

/**
 * Split a transcript-permission payload into "the tenant switched Graph
 * transcript access off" and everything else (a missing app permission, or
 * speaker attribution being off), which stay on the admin-consent copy.
 *
 * The distinction is what the user does next: the first is fixed in the Teams
 * admin center by a Teams administrator, the second in the app registration.
 */
function transcriptForbiddenReason(error?: string): TranscriptReason {
	return error?.startsWith(TRANSCRIPT_ACCESS_DISABLED_PREFIX)
		? "transcript-access-disabled"
		: "admin-consent-required";
}

/**
 * The success branch also reports WHICH Graph meeting and transcript were
 * resolved (#2170).
 *
 * The import procedure keys its duplicate check on that pair: a Graph
 * transcript is immutable once produced, so `(meetingId, transcriptId)` is the
 * only value that identifies "this occurrence's content" — `joinUrl` is shared
 * by every instance of a recurring series, and the calendar `startTime` belongs
 * to the event, not the transcript.
 *
 * Additive, and it does not widen what this file does: the ids were already
 * resolved here to fetch the body at all. They are deliberately absent from
 * every failure branch — there is no occurrence to name — and
 * `getPersonalTranscript` projects them back out, so the on-demand read the
 * browser receives is unchanged.
 */
export type PersonalTranscriptResult =
	| {
			content: string;
			reason?: undefined;
			meetingId: string;
			transcriptId: string;
	  }
	| { content: null; reason: TranscriptReason };

/**
 * Pick the transcript closest in time to the meeting's start.
 *
 * A recurring series shares one onlineMeeting id, so a long-running series can
 * return many transcripts; the nearest-createdDateTime one is the occurrence
 * the user clicked.
 *
 * Transcripts with no createdDateTime score Infinity so they sort last. That
 * matters: without it their comparator results are NaN, and ECMA-262's
 * SortCompare coerces a NaN comparefn result to +0 — "equal" — so an undated
 * transcript would simply hold its input position and could win over a dated
 * one. (The fetch-meeting-notes version of this logic has that flaw.)
 *
 * NEAREST IS NOT ENOUGH, and that was a data-integrity bug. `meetingId` is the
 * SERIES, so this list answers for every occurrence of a recurring meeting.
 * Picking the nearest with no bound meant that clicking an occurrence which was
 * never recorded returned some other week's conversation — and the import then
 * stored it under the clicked occurrence's date, leaving the project holding one
 * meeting's words labelled as another's. Observed on staging: five occurrences
 * spanning December to February all resolved to one transcript id.
 *
 * So the winner must also COVER the occurrence, by the same rule the team lane
 * uses in `transcriptCoversOccurrence` (list-digest.ts): the same UTC day, or
 * produced within a day AFTER the start, which is how a meeting running past
 * midnight lands its transcript on the following date. The rule is expressed
 * twice rather than shared because this module deliberately keeps `callGraph`
 * as its only dependency; `utcDayKey` is imported since it is already the shared
 * home of the day rule. If you tune one, check the other.
 */
export function selectTranscriptId(
	transcripts: Array<{ id: string; createdDateTime?: string }>,
	startTime?: string,
): string | null {
	if (transcripts.length === 0) {
		return null;
	}
	// No occurrence to check against — the caller wants whatever exists.
	if (!startTime) {
		return transcripts[0].id;
	}

	// Explicitness guard, NOT a correctness one — removing it is unobservable.
	// If target is NaN then every comparator result is NaN, SortCompare coerces
	// those to +0, and the sort degenerates to a stable no-op that returns
	// transcripts[0] anyway. Kept because leaning on that coercion rule to
	// express "an unparseable start time means no preference" asks far too much
	// of the next reader. Do not add a test claiming to pin this branch: no
	// sort-based fixture can distinguish its presence (verified empirically).
	const target = new Date(startTime).getTime();
	if (Number.isNaN(target)) {
		return transcripts[0].id;
	}

	const distance = (createdDateTime?: string): number => {
		const t = new Date(createdDateTime ?? "").getTime();
		return Number.isNaN(t)
			? Number.POSITIVE_INFINITY
			: Math.abs(t - target);
	};

	const chosen = [...transcripts].sort(
		(a, b) => distance(a.createdDateTime) - distance(b.createdDateTime),
	)[0];

	return coversOccurrence(chosen.createdDateTime, target) ? chosen.id : null;
}

/**
 * Does this transcript plausibly belong to the occurrence that starts at
 * `occurrenceStart`?
 *
 * An undated transcript answers TRUE: there is nothing to compare, so there is
 * nothing to disprove, and discarding it would lose a transcript that is
 * probably the right one. Undated transcripts already sort last, so this only
 * decides the case where one is all that exists.
 */
function coversOccurrence(
	createdDateTime: string | undefined,
	occurrenceStart: number,
): boolean {
	if (!createdDateTime) {
		return true;
	}
	const created = new Date(createdDateTime);
	const createdAt = created.getTime();
	if (Number.isNaN(createdAt)) {
		return true;
	}
	if (utcDayKey(created) === utcDayKey(new Date(occurrenceStart))) {
		return true;
	}
	const delta = createdAt - occurrenceStart;
	return delta >= 0 && delta < 24 * 60 * 60 * 1000;
}

/** Render a Graph transcript payload as plain readable text. */
export function formatTranscript(payload: {
	content?: string;
	entries?: Array<{ speaker: string; text: string }>;
}): string {
	if (payload.entries && payload.entries.length > 0) {
		return payload.entries
			.map((entry) => `${entry.speaker}: ${entry.text}`)
			.join("\n");
	}
	return payload.content ?? "";
}

/**
 * Run the 3-call Graph chain: join URL -> onlineMeeting id -> transcript list
 * -> transcript content.
 *
 * Known, actionable states come back as a `reason` rather than a throw — see
 * DEF-6: a colleague-organised meeting is an ordinary state, and throwing put
 * the join URL (a meeting capability URL) on the error path. Genuinely
 * unexpected failures rethrow for the caller to wrap.
 */
export async function fetchPersonalTranscriptContent(args: {
	callGraph: (
		methodName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>;
	joinUrl: string;
	startTime?: string;
}): Promise<PersonalTranscriptResult> {
	const { callGraph, joinUrl, startTime } = args;

	try {
		// Step 1: join URL -> onlineMeeting id
		const meetingResult = (await callGraph("get_meeting_by_join_url", {
			joinWebUrl: joinUrl,
		})) as { meeting?: { id: string } | null; error?: string };

		if (!meetingResult.meeting?.id) {
			return { content: null, reason: "no-transcript" };
		}
		const meetingId = meetingResult.meeting.id;

		// Step 2: list transcripts for that meeting
		const listResult = (await callGraph("list_meeting_transcripts", {
			meetingId,
		})) as {
			transcripts?: Array<{ id: string; createdDateTime?: string }>;
			error?: string;
			helpUrl?: string;
		};

		// The Graph client returns a structured, non-throwing payload with a
		// helpUrl when transcript access is blocked — whether by a missing
		// OnlineMeetingTranscript.Read.All grant or by the Teams tenant
		// setting. That is an actionable state, not a failure.
		if (listResult.helpUrl) {
			return {
				content: null,
				reason: transcriptForbiddenReason(listResult.error),
			};
		}

		const transcriptId = selectTranscriptId(
			listResult.transcripts ?? [],
			startTime,
		);
		if (!transcriptId) {
			return { content: null, reason: "no-transcript" };
		}

		// Step 3: fetch the content
		const contentResult = (await callGraph(
			"get_meeting_transcript_content",
			{
				meetingId,
				transcriptId,
			},
		)) as {
			content?: string;
			entries?: Array<{ speaker: string; text: string }>;
			error?: string;
			helpUrl?: string;
		};

		if (contentResult.helpUrl) {
			return {
				content: null,
				reason: transcriptForbiddenReason(contentResult.error),
			};
		}
		if (contentResult.error) {
			return { content: null, reason: "no-transcript" };
		}

		const text = formatTranscript(contentResult);
		if (text.trim().length === 0) {
			return { content: null, reason: "no-transcript" };
		}

		return { content: text, meetingId, transcriptId };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";

		if (isMicrosoftNotConnectedError(message)) {
			return { content: null, reason: "not-connected" };
		}

		// Graph will not resolve a meeting this caller cannot look up —
		// typically one a colleague organised. An expected state with its own
		// UI copy, not a failure (DEF-6). Throwing here also meant the join
		// URL rode into the error path on every such click; the audit-error
		// middleware suppresses these procedures by name, but not raising at
		// all is the sturdier guarantee.
		if (isMeetingLookupForbiddenError(message)) {
			return { content: null, reason: "no-access" };
		}

		// #2170. The other way Graph says it cannot resolve the join URL. Left
		// as a throw, it was the single largest source of 500s on this path.
		if (isMeetingNotFoundError(message)) {
			return { content: null, reason: "meeting-not-found" };
		}

		throw error;
	}
}
