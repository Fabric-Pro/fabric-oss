/**
 * The pure half of the personal-meeting import (#2170): the transcript body
 * and the metadata blob that get written to a `ProjectContext`.
 *
 * Split out from the procedure deliberately. The procedure is the one place in
 * the personal-meeting lane that touches the database, so keeping the format
 * decisions here — where they are testable without a Graph stub, a Prisma
 * mock, or a session — keeps that file down to its permission gates, its Graph
 * read, and its single write.
 *
 * FORMAT PARITY IS LOAD-BEARING. `meeting-transcript-sync.ts` (step 5) writes
 * the same header for team meetings, and three consumers read it back:
 * `ProjectContextsList` groups meeting rows by `metadata.meetingId`, the
 * backlog analyzer feeds the body in as a `meetingTranscripts` section, and the
 * context detail page renders it verbatim. An imported meeting that carried a
 * near-miss variant of the format would render and analyze subtly differently
 * from a synced one for no reason a reader could see.
 */

/**
 * Refuse rather than slice.
 *
 * The card's NFR asks that long transcripts be handled "without silent
 * truncation", and the import deliberately performs no lossy transform (unlike
 * the team sync path, which LLM-summarises above 50k chars because it ingests
 * automatically and cannot ask). This ceiling exists only so a pathological
 * payload fails loudly instead of being written; at ~1M chars it is roughly a
 * twenty-hour meeting, far past anything real.
 */
export const MAX_IMPORT_CHARS = 1_000_000;

/**
 * Longest prefix still plausibly a person's display name.
 *
 * Transcript bodies are `"<speaker>: <text>"` lines, but spoken text contains
 * colons too ("the rule is simple: never ship on a Friday"). Splitting on the
 * FIRST colon handles that — the speaker is whatever precedes it — while this
 * cap rejects the case where a line has no speaker prefix at all and the first
 * colon lands deep inside prose.
 */
const MAX_SPEAKER_NAME_LENGTH = 80;

/**
 * Pull the distinct speaker names out of a formatted transcript, in the order
 * they first speak.
 *
 * Graph's structured payload is rendered as `"<speaker>: <text>"` by
 * `formatTranscript`, so the names are recoverable from the text alone — which
 * is what keeps this module pure. A raw-VTT transcript (Graph returned
 * `content` rather than `entries`) has no speaker prefixes and yields an empty
 * list; callers omit the participants line entirely in that case, exactly as
 * the team path does.
 */
export function speakerNamesFromTranscript(transcript: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();

	for (const line of transcript.split("\n")) {
		const separator = line.indexOf(": ");
		if (separator <= 0 || separator > MAX_SPEAKER_NAME_LENGTH) {
			continue;
		}
		const name = line.slice(0, separator).trim();
		if (name.length === 0 || seen.has(name)) {
			continue;
		}
		seen.add(name);
		names.push(name);
	}

	return names;
}

/**
 * Render `occurrenceDate` the way the team ingest path does.
 *
 * `toLocaleString()` is inherited from `meeting-transcript-sync.ts` for parity.
 * The extra `Number.isNaN` branch is not: the team path would happily write
 * "Invalid Date" into the header for a malformed date, and an imported meeting
 * should say "Unknown date" like it does for a missing one.
 */
function formatOccurrenceDate(occurrenceDate?: string): string {
	if (!occurrenceDate) {
		return "Unknown date";
	}
	const parsed = new Date(occurrenceDate);
	return Number.isNaN(parsed.getTime())
		? "Unknown date"
		: parsed.toLocaleString();
}

/**
 * Build the stored context body: the team-format header followed by the
 * transcript, verbatim.
 */
export function buildImportedTranscriptContent(args: {
	meetingSubject: string;
	occurrenceDate?: string;
	transcript: string;
}): string {
	const { meetingSubject, occurrenceDate, transcript } = args;
	const speakers = speakerNamesFromTranscript(transcript);

	const lines = [
		`## Meeting Transcript: ${meetingSubject}`,
		`**Date:** ${formatOccurrenceDate(occurrenceDate)}`,
		...(speakers.length > 0
			? [`**Participants:** ${speakers.join(", ")}`]
			: []),
		"",
	];

	// NO `---` RULE, and it is load-bearing twice over.
	//
	// `meeting-transcript-sync.ts` builds the same header ending in `"---", ""`
	// and then runs `.filter(Boolean)`, which drops the empty trailing slot and
	// glues the rule to the first line of dialogue — every synced transcript
	// really reads `---Ada: hello`. Emitting a well-formed standalone `---`
	// instead looked like the obvious fix. It is not: alone on a line, that rule
	// breaks two things a glued one cannot.
	//
	//  1. MARKDOWN. A `---` line directly under a paragraph is a setext heading
	//     underline, not a thematic break, so the `**Date:** … **Participants:**
	//     …` line renders as a page-sized heading in the context viewer.
	//  2. THE ANALYZER. `analyze-context.ts` joins the selected transcripts with
	//     `"\n\n---\n\n"`. A standalone `---` inside a body is indistinguishable
	//     from that delimiter, so one imported meeting arrives at the model
	//     looking like two, splitting its dialogue across a boundary the prompt
	//     says separates unrelated meetings.
	//
	// A blank line does the separating job with neither hazard.
	return `${lines.join("\n")}\n${transcript}`;
}

export interface ImportedContextMetadata {
	provider: "microsoft-teams";
	origin: "personal-import";
	meetingId: string;
	transcriptId: string;
	joinUrl: string;
	meetingSubject: string;
	meetingDate?: string;
	speakerNames: string[];
	wasSummarized: false;
	importedByUserId: string;
	importedAt: string;
}

/**
 * The metadata written alongside the body.
 *
 * `meetingId` + `transcriptId` are the dedup key (spec D2) — a Graph transcript
 * is immutable once produced, so the same pair always means the same content
 * and a re-import is a no-op. `origin` marks the row as one a person chose to
 * import rather than one the sync path pulled in, which is what lets the
 * backlog analyzer resolve an imported meeting that has no
 * `ProjectLinkedMeeting` behind it.
 *
 * `wasSummarized` is hardcoded `false` rather than omitted: the field is part of
 * the shape the team path writes, and a reader that treats "absent" as "unknown"
 * would have to guess. The import never summarises (spec D3).
 */
export function buildImportedContextMetadata(args: {
	meetingId: string;
	transcriptId: string;
	joinUrl: string;
	meetingSubject: string;
	occurrenceDate?: string;
	speakerNames: string[];
	importedByUserId: string;
	importedAt: Date;
}): ImportedContextMetadata {
	return {
		provider: "microsoft-teams",
		origin: "personal-import",
		meetingId: args.meetingId,
		transcriptId: args.transcriptId,
		joinUrl: args.joinUrl,
		meetingSubject: args.meetingSubject,
		meetingDate: args.occurrenceDate,
		speakerNames: args.speakerNames,
		wasSummarized: false,
		importedByUserId: args.importedByUserId,
		importedAt: args.importedAt.toISOString(),
	};
}
