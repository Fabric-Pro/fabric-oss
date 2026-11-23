import { db } from "@repo/database";
import type { ParlumeSpeakerMark } from "./parlume-guests";

/**
 * Records how Fabric marked a participant it checked, once: by the same
 * outcome it relays to the bridge, a member it confirmed or a guest it
 * could not. Only the participant's Teams id and the mark are kept, and
 * both go with the meeting's segments.
 */
export async function recordParlumeSpeakerMark(input: {
	sessionId: string;
	participantId: string;
	mark: Exclude<ParlumeSpeakerMark, "unknown">;
}): Promise<void> {
	const { sessionId, participantId } = input;
	switch (input.mark) {
		case "member":
			await db.parlumeMeetingSession.updateMany({
				where: {
					id: sessionId,
					NOT: { memberSpeakerIds: { has: participantId } },
				},
				data: { memberSpeakerIds: { push: participantId } },
			});
			return;
		case "guest":
			await db.parlumeMeetingSession.updateMany({
				where: {
					id: sessionId,
					NOT: { guestSpeakerIds: { has: participantId } },
				},
				data: { guestSpeakerIds: { push: participantId } },
			});
			return;
		default: {
			const unreachable: never = input.mark;
			throw new Error(`Unknown Parlume speaker mark: ${unreachable}`);
		}
	}
}
