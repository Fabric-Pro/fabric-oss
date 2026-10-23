/** Token capacity and its character estimate for analysis allocation. */
export const MAX_TOKEN_BUDGET = 80_000;
export const CHARS_PER_TOKEN = 4;
// Match the analysis allocator's UTF-16 character estimate. Only the payload
// share below measures UTF-8 bytes, including JSON escaping on the wire.
export const MAX_ANALYSIS_CHARS = MAX_TOKEN_BUDGET * CHARS_PER_TOKEN;

// A 1.5 MiB allowance for the meeting array alone, below the 2 MiB payload warning
// threshold. Cap JSON-encoded strings too: escaping can grow the wire representation
// even when the raw UTF-8 text fits.
export const MEETING_PAYLOAD_BUDGET_BYTES = 1.5 * 1024 * 1024;

export function meetingTranscriptCeiling(selectedMeetingCount = 1) {
	const count =
		Number.isFinite(selectedMeetingCount) && selectedMeetingCount > 0
			? Math.ceil(selectedMeetingCount)
			: 1;
	const share = Math.floor(MEETING_PAYLOAD_BUDGET_BYTES / count);
	return {
		maxChars: MAX_ANALYSIS_CHARS,
		maxBytes: share,
		// Allow for the array's brackets and commas alongside serialized string bytes.
		serializedBytes: Math.max(0, share - 3),
	};
}

type MeetingCeiling = ReturnType<typeof meetingTranscriptCeiling>;
export function transcriptFitsCeiling(
	text: string,
	ceiling: MeetingCeiling,
): boolean {
	return (
		text.length <= ceiling.maxChars &&
		Buffer.byteLength(text, "utf8") <= ceiling.maxBytes &&
		Buffer.byteLength(JSON.stringify(text), "utf8") <=
			ceiling.serializedBytes
	);
}

/** Keep a Unicode-safe prefix within character, raw-byte and serialized-byte limits. */
export function truncateTranscriptToCeiling(
	text: string,
	ceiling: MeetingCeiling,
	notice = "",
): string {
	if (transcriptFitsCeiling(text, ceiling)) {
		return text;
	}
	let low = 0;
	// A pathologically small share may not hold even the notice. Retain as much
	// of it as fits rather than returning an unlabelled source fragment.
	if (notice && !transcriptFitsCeiling(notice, ceiling)) {
		return truncateTranscriptToCeiling(notice, ceiling);
	}
	let high = Math.min(text.length, ceiling.maxChars, ceiling.maxBytes);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (transcriptFitsCeiling(text.slice(0, mid) + notice, ceiling)) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	// A UTF-16 slice must not leave half a surrogate pair at its end.
	const last = text.charCodeAt(low - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		low--;
	}
	return text.slice(0, low) + notice;
}

export const TRANSCRIPT_TRUNCATION_NOTICE =
	"\n\n[... truncated to fit transcript budget ...]";
