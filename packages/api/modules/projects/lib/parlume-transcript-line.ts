import type { ParlumeMeetingSegmentSource } from "@repo/database/prisma/generated/enums";
import {
	PARLUME_TRANSCRIPT_CHAT_PREFIX,
	parlumeTranscriptText,
} from "@repo/utils/parlume-notes";
import { type ParlumeSpeakerMarks, parlumeSpeakerMark } from "./parlume-guests";

// Chat lines and Parlume's own markers (a pause, a resume) stand apart from speech.
const SEGMENT_PREFIX: Record<ParlumeMeetingSegmentSource, string> = {
	SPEECH: "",
	CHAT: PARLUME_TRANSCRIPT_CHAT_PREFIX,
	EVENT: "[Parlume] ",
};

/**
 * Who said a line, as the transcript names them. A guest's words are kept,
 * and may be quoted, marked as an unverified speaker's.
 */
function transcriptSpeaker(
	segment: { speakerName: string | null; speakerId: string | null },
	marks: ParlumeSpeakerMarks,
): string | null {
	const mark = parlumeSpeakerMark(
		{ id: segment.speakerId, name: segment.speakerName },
		marks,
	);
	if (mark !== "guest") {
		return segment.speakerName;
	}
	return segment.speakerName
		? `${segment.speakerName} (unverified speaker)`
		: "Unverified speaker";
}

/**
 * One segment as a line of the saved transcript, the line meeting notes cite.
 * A chat message of several lines keeps them, each line break written as
 * "\r\n", so the notes can tell where the segment ends. Finalization writes
 * the transcript with it, and the notes evaluation builds its synthetic
 * transcripts with it.
 */
export function parlumeTranscriptLine(
	segment: {
		text: string;
		speakerName: string | null;
		speakerId: string | null;
		source: ParlumeMeetingSegmentSource;
	},
	marks: ParlumeSpeakerMarks,
): string {
	const speaker = transcriptSpeaker(segment, marks);
	const line = speaker ? `${speaker}: ${segment.text}` : segment.text;
	return parlumeTranscriptText(`${SEGMENT_PREFIX[segment.source]}${line}`);
}
