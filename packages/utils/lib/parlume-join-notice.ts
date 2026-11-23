/**
 * The notice Parlume posts in the meeting chat when it is admitted, and the
 * same words the auto-join switch shows before anyone turns it on. Fabric
 * hands the bridge the text to post; the bridge adds the post's tag in front.
 */

export const PARLUME_JOIN_NOTICE_TITLE =
	"Fabric Parlume (AI assistant) is in this meeting";

export const PARLUME_JOIN_NOTICE_BODY =
	"I transcribe the meeting and write notes. I keep transcripts for 90 days, and notes until someone deletes them.";

export const PARLUME_JOIN_NOTICE_PAUSE =
	'To pause me, say or type "Parlume, pause".';

/** The chat post, after its tag: bold title, then one line each. */
export function parlumeJoinNoticeText(pageUrl: string): string {
	return [
		`**${PARLUME_JOIN_NOTICE_TITLE}**`,
		PARLUME_JOIN_NOTICE_BODY,
		`${PARLUME_JOIN_NOTICE_PAUSE} [Parlume page](${pageUrl})`,
	].join("\n");
}

/**
 * The one sentence Parlume says instead when it cannot write in the meeting
 * chat.
 */
export const PARLUME_JOIN_NOTICE_SPOKEN =
	'Fabric Parlume, an AI assistant, is in this meeting to transcribe it and write notes, keeps transcripts for 90 days, cannot write in this meeting\'s chat, and pauses when you say "Parlume, pause".';
