import { PROPOSAL_NOTE_TITLE_MAX_CODE_POINTS } from "@repo/instructions";

export type ProposalNoteInput = { title?: string; body?: string };

/**
 * The note a repository suggestion is rendered from, with the commit message
 * the person typed folded in.
 *
 * A suggestion has no commit message of its own: the pull request's title and
 * its commit message are both rendered from the note. A typed message becomes
 * the title unless the note already has one. A message longer than a title
 * allows keeps its remainder at the top of the description, so nothing typed
 * is dropped.
 */
export function noteWithCommitMessage(
	note: ProposalNoteInput | undefined,
	message: string | undefined,
): ProposalNoteInput | undefined {
	const typed = message?.trim() ?? "";
	if (typed === "" || (note?.title?.trim() ?? "") !== "") {
		return note;
	}
	const points = Array.from(typed);
	if (points.length <= PROPOSAL_NOTE_TITLE_MAX_CODE_POINTS) {
		return { ...note, title: typed };
	}
	const title = points
		.slice(0, PROPOSAL_NOTE_TITLE_MAX_CODE_POINTS)
		.join("")
		.trimEnd();
	const rest = points
		.slice(PROPOSAL_NOTE_TITLE_MAX_CODE_POINTS)
		.join("")
		.trim();
	const body = [rest, note?.body ?? ""].filter((part) => part !== "");
	return { ...note, title, body: body.join("\n\n") };
}
