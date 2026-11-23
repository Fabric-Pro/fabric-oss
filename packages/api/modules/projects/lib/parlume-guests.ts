// Teams gives a participant who joined without signing in an id of this
// kind; Attendee passes it on as the participant's uuid.
const ANONYMOUS_PARTICIPANT_ID = /^8:(?:teamsvisitor|anonymous):/i;
// Teams adds these to the name of someone from outside the organization.
const EXTERNAL_NAME_MARKER = /\((?:guest|external|unverified)\)\s*$/i;

/**
 * Whether a participant Attendee reports is an external guest: someone who
 * joined without signing in, or whom Teams labels as a guest or external.
 * A display name proves nothing: a guest may call themselves "Fabric
 * Parlume". Attendee sends no join or leave for its own bot, so the bot needs
 * no exemption here; its own chat echoes, if counted as a guest's, are only
 * refused as commands.
 * A guest from another organization who signed in with their own account
 * and carries no label is not recognized here; an invitation that names
 * them is (see {@link hasParlumeExternalInvitees}).
 */
export function isParlumeExternalParticipant(participant: {
	id: string;
	name: string | null;
}): boolean {
	const name = participant.name?.trim() ?? "";
	return (
		ANONYMOUS_PARTICIPANT_ID.test(participant.id) ||
		EXTERNAL_NAME_MARKER.test(name)
	);
}

/**
 * How the transcript and the Parlume page mark a speaker. `member`: Fabric
 * confirmed them, by their Teams sign-in, as a Fabric user who can read the
 * project. `guest`: they joined without signing in, Teams labels them a
 * guest or external, or Fabric checked them and could not confirm them.
 * `unknown`: Fabric has no word of them yet, as for a line Teams has not
 * given a speaker. A guest's words are kept and may be quoted; the bridge
 * takes no request from a guest, by the same check that marks them.
 */
export type ParlumeSpeakerMark = "member" | "guest" | "unknown";

/** The participants Fabric checked in a meeting, by their Teams id. */
export interface ParlumeSpeakerMarks {
	memberSpeakerIds: string[];
	guestSpeakerIds: string[];
}

/**
 * The mark of one speaker. `userId` is the Fabric account a request
 * recorded as its confirmed asker. A guest mark wins over any other.
 */
export function parlumeSpeakerMark(
	speaker: {
		id: string | null;
		name: string | null;
		userId?: string | null;
	},
	marks: ParlumeSpeakerMarks,
): ParlumeSpeakerMark {
	const { id } = speaker;
	if (
		isParlumeExternalParticipant({ id: id ?? "", name: speaker.name }) ||
		(id !== null && marks.guestSpeakerIds.includes(id))
	) {
		return "guest";
	}
	const confirmed =
		Boolean(speaker.userId) ||
		(id !== null && marks.memberSpeakerIds.includes(id));
	return confirmed ? "member" : "unknown";
}

function emailDomain(email: string): string | null {
	const at = email.lastIndexOf("@");
	const domain =
		at > 0
			? email
					.slice(at + 1)
					.trim()
					.toLowerCase()
			: "";
	return domain || null;
}

/**
 * Whether an automatic join's invitation names someone outside the
 * organization: an invitee whose email domain is not the domain of the person
 * who turned auto-join on, whose calendar it was read from. Without a domain
 * to compare with, every invitee counts as external, so the meeting is
 * treated as having a guest.
 */
export function hasParlumeExternalInvitees(input: {
	inviteeDomains: string[];
	enablerEmail: string | null;
}): boolean {
	const internal = input.enablerEmail
		? emailDomain(input.enablerEmail)
		: null;
	return input.inviteeDomains.some(
		(domain) => domain.trim().toLowerCase() !== internal,
	);
}

/** At most this many invitee addresses are kept on a session. */
export const PARLUME_MAX_INVITEE_EMAILS = 200;

/**
 * The addresses of an automatic join's invitees from inside the organization,
 * by the rule of {@link hasParlumeExternalInvitees}: lower-cased, each once,
 * and at most {@link PARLUME_MAX_INVITEE_EMAILS}. They may read the meeting's
 * transcript. Without a domain to compare with, none is internal.
 */
export function parlumeInternalInviteeEmails(input: {
	inviteeEmails: string[];
	enablerEmail: string | null;
}): string[] {
	const internal = input.enablerEmail
		? emailDomain(input.enablerEmail)
		: null;
	if (!internal) {
		return [];
	}
	const emails = input.inviteeEmails.map((email) =>
		email.trim().toLowerCase(),
	);
	return [
		...new Set(emails.filter((email) => emailDomain(email) === internal)),
	].slice(0, PARLUME_MAX_INVITEE_EMAILS);
}
