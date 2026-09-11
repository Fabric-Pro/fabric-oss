/**
 * Shared implementation of the `fabric_list_meeting_transcripts` tool.
 *
 * Both agent seams expose this tool — the orchestrator (via its step handler)
 * and direct chat (via the built-in tool factory) — and they must answer a date
 * question identically. Keeping the filter parsing and the rendering here means
 * the two cannot drift into disagreeing about what "yesterday" matched.
 *
 * Why the tool exists at all: `project_rag_query` cannot answer a date question.
 * The meeting date never reaches the vector payload, so "any transcripts from
 * September 10?" is scored on wording alone against hundreds of near-identical
 * standups. On production the agent answered "no" and named the newest date it
 * happened to retrieve as the most recent on record — twice, months apart from
 * each other — while the transcript sat in the project ready and embedded the
 * whole time (Fizzy #2473). A date question deserves a lookup, not a guess.
 */

export interface TranscriptFilters {
	from?: Date;
	to?: Date;
	subject?: string;
	limit?: number;
}

export interface TranscriptListing {
	response: string;
	transcriptCount: number;
	total: number;
}

/** Parse an ISO date, tolerating a bare `YYYY-MM-DD`. Invalid input is ignored. */
export function parseTranscriptDate(
	value: unknown,
	endOfDay: boolean,
): Date | undefined {
	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}
	const raw = value.trim();
	// A bare calendar date carries no time. Read `to` as the END of that day so
	// `from = to = "2026-09-10"` means the whole of the 10th rather than
	// midnight — which would match nothing for an afternoon meeting.
	const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
		? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
		: raw;
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function readTranscriptFilters(
	args: Record<string, unknown> | undefined,
): TranscriptFilters {
	const filters: TranscriptFilters = {};
	const from = parseTranscriptDate(args?.from, false);
	const to = parseTranscriptDate(args?.to, true);
	if (from) {
		filters.from = from;
	}
	if (to) {
		filters.to = to;
	}
	const subject = args?.subject;
	if (typeof subject === "string" && subject.trim() !== "") {
		filters.subject = subject.trim();
	}
	const limit = args?.limit;
	if (typeof limit === "number" && Number.isFinite(limit)) {
		filters.limit = Math.trunc(limit);
	}
	return filters;
}

function formatDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function describeTranscriptFilters(filters: TranscriptFilters): string {
	const parts: string[] = [];
	if (filters.from && filters.to) {
		const from = formatDay(filters.from);
		const to = formatDay(filters.to);
		parts.push(from === to ? `on ${from}` : `between ${from} and ${to}`);
	} else if (filters.from) {
		parts.push(`on or after ${formatDay(filters.from)}`);
	} else if (filters.to) {
		parts.push(`on or before ${formatDay(filters.to)}`);
	}
	if (filters.subject) {
		parts.push(`matching "${filters.subject}"`);
	}
	return parts.length > 0 ? ` ${parts.join(", ")}` : "";
}

type TranscriptForDisplay = {
	meetingSubject: string | null;
	meetingDate: Date | null;
	speakerNames: string[];
	summary: string | null;
	wasSummarized: boolean;
};

export function formatTranscriptList(
	transcripts: TranscriptForDisplay[],
	total: number,
	filters: TranscriptFilters,
): string {
	const shown = transcripts.length;
	const scope = describeTranscriptFilters(filters);
	const noun = `meeting transcript${total === 1 ? "" : "s"}`;
	const header =
		shown < total
			? `${total} ${noun}${scope} (showing the ${shown} most recent):`
			: `${total} ${noun}${scope}:`;

	const blocks = transcripts.map((t, i) => {
		const date = t.meetingDate ? formatDay(t.meetingDate) : "date unknown";
		const subject = t.meetingSubject?.trim() || "Untitled meeting";
		const lines = [`${i + 1}. ${date} — ${subject}`];
		if (t.speakerNames.length > 0) {
			lines.push(`   Speakers: ${t.speakerNames.join(", ")}`);
		}
		if (t.summary?.trim()) {
			const summary = t.summary.trim();
			lines.push(
				`   Summary: ${summary.slice(0, 300)}${summary.length > 300 ? "…" : ""}`,
			);
		}
		if (t.wasSummarized) {
			// The stored body is a digest, not the words people said. Say so —
			// quoting a summary as verbatim speech is its own failure mode.
			lines.push(
				"   Note: stored content is an AI summary, not the verbatim transcript.",
			);
		}
		return lines.join("\n");
	});

	return `${header}\n\n${blocks.join("\n\n")}`;
}

export interface TranscriptListingRequest {
	projectId: string;
	userId: string;
	organizationId?: string;
	filters: TranscriptFilters;
}

/**
 * Access-check, query and render, shared by both agent seams.
 *
 * The empty result deliberately says what was searched. An unqualified "no
 * transcripts" is the failure this tool exists to end — a reader cannot tell a
 * genuinely empty range from a lookup that never ran.
 */
export async function listProjectMeetingTranscripts(
	request: TranscriptListingRequest,
): Promise<TranscriptListing> {
	const { projectId, userId, organizationId, filters } = request;
	const { hasProjectAccess, listMeetingTranscriptsByDate } = await import(
		"@repo/database"
	);

	const hasAccess = await hasProjectAccess(projectId, userId, organizationId);
	if (!hasAccess) {
		return {
			response:
				"You don't have access to this project's meeting transcripts.",
			transcriptCount: 0,
			total: 0,
		};
	}

	const result = await listMeetingTranscriptsByDate({
		projectId,
		...(filters.from ? { from: filters.from } : {}),
		...(filters.to ? { to: filters.to } : {}),
		...(filters.subject ? { subjectContains: filters.subject } : {}),
		...(filters.limit ? { limit: filters.limit } : {}),
	});

	if (result.items.length === 0) {
		return {
			response:
				`No meeting transcripts in this project${describeTranscriptFilters(filters)}. ` +
				"This is a direct lookup over synced transcripts, so the range really is empty — " +
				"but a meeting only appears once its transcript has synced from the provider.",
			transcriptCount: 0,
			total: 0,
		};
	}

	return {
		response: formatTranscriptList(result.items, result.total, filters),
		transcriptCount: result.items.length,
		total: result.total,
	};
}
