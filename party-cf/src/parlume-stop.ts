// What stops Parlume, who asked, and what the meeting chat says about it.

/** Why Parlume may not speak: past the meeting's cap, paused, or a guest is in. */
export type ParlumeSpeechGate = "cap" | "pause" | "guest";

/**
 * Why Parlume stopped: a gate closed, or someone asked, by saying a stop
 * (`voice`), by typing one in the meeting chat (`chat`) or with the Parlume
 * page's button (`page`). A pause is asked for and closes the gate.
 */
export type ParlumeSpeechStopCause =
	| ParlumeSpeechGate
	| "voice"
	| "chat"
	| "page";

/** A stop someone asked for, and with it the answer they ended. */
export type ParlumeAskedStopCause = "voice" | "chat" | "page";

/** How a stop said aloud was heard, for the `speech.stopped` log. */
export interface ParlumeStopDetection {
	/** From the end of the stop's words to the moment Parlume went quiet. */
	detectMs: number;
	/** Speech held on a partial transcript, which the final confirmed. */
	confirmed: boolean;
}

/** Who stopped or paused Parlume. */
export interface ParlumeStopActor {
	/** As the meeting chat shows them. */
	name: string | null;
	/** A member's user id, or a chat sender's or speaker's participant id. */
	id: string | null;
}

export interface ParlumeStopResult {
	/** Parlume was speaking, playing queued audio, or preparing an answer. */
	stopped: boolean;
	/** Who asked for the answer that was stopped, when the floor knows a name. */
	asker: string | null;
}

/** How Fabric records a turn someone stopped (its `ParlumeStopCause`). */
export interface ParlumeTurnStop {
	cause: "VOICE" | "CHAT" | "PAGE" | "PAUSE";
	by: string | null;
}

/** How Fabric records a stop, or null for a gate that lets the turn run on. */
export function parlumeTurnStop(
	cause: ParlumeSpeechStopCause,
	actor: ParlumeStopActor | null,
): ParlumeTurnStop | null {
	const by = actor?.name ?? null;
	switch (cause) {
		case "cap":
		case "guest":
			return null;
		case "voice":
			return { cause: "VOICE", by };
		case "chat":
			return { cause: "CHAT", by };
		case "page":
			return { cause: "PAGE", by };
		case "pause":
			return { cause: "PAUSE", by };
		default: {
			const unreachable: never = cause;
			return unreachable;
		}
	}
}

/**
 * A person as these notices name them: by first name. A typed command
 * carries the full name Teams shows ("Dana Member"), a member on the Parlume
 * page their Fabric account's name, which is often the first name alone; one
 * form keeps a pause and its resume naming the same person alike. A
 * "Member, Dana" display name gives "Dana".
 */
export function parlumeFirstName(
	name: string | null | undefined,
): string | null {
	const trimmed = name?.trim();
	if (!trimmed) {
		return null;
	}
	const given = trimmed.includes(",")
		? trimmed.slice(trimmed.indexOf(",") + 1).trim()
		: trimmed;
	return given.split(/\s+/)[0] || trimmed;
}

function named(actor: ParlumeStopActor | null): string {
	return parlumeFirstName(actor?.name) ?? "Someone";
}

/** The one line a stopped answer leaves in the meeting chat. */
export function parlumeStoppedNotice(
	actor: ParlumeStopActor | null,
	asker: string | null,
): string {
	const forAsker = parlumeFirstName(asker);
	return `**Stopped** · ${named(actor)} stopped the answer${forAsker ? ` for ${forAsker}` : ""}`;
}

export function parlumePausedNotice(actor: ParlumeStopActor | null): string {
	return `**Listening paused** by ${named(actor)}\nI hear nothing until a member resumes me on the Parlume page.`;
}

export function parlumeResumedNotice(actor: ParlumeStopActor | null): string {
	return `**Listening again** · resumed by ${named(actor)}`;
}
