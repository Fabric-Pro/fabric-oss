import type { ParlumeMeetingEndReason } from "@repo/database/prisma/generated/enums";
import { PARLUME_LOBBY_WAIT_SECONDS } from "./parlume-attendee";

/**
 * Why a provider-reported failure ended a session, in words the Parlume page
 * shows. Attendee reports a bot that never got in as `could_not_join_meeting`
 * with a sub type, and every other failure as `fatal_error`; both move the bot
 * to its `fatal_error` state. The sub types are Attendee's API codes
 * (`BotEventSubTypes.sub_type_to_api_code` in attendee-labs/attendee,
 * bots/models.py).
 */
export interface ParlumeProviderFailure {
	endReason: ParlumeMeetingEndReason;
	message: string;
}

const GENERIC_FAILURE = "Parlume meeting bot failed.";

const lobbyMinutes = Math.round(PARLUME_LOBBY_WAIT_SECONDS / 60);

// Maps, not object literals: the sub type comes from the webhook, and a key
// like `constructor` must not resolve to the object prototype.
const COULD_NOT_JOIN = new Map<string, ParlumeProviderFailure>([
	[
		"waiting_room_timeout_exceeded",
		{
			endReason: "NOT_ADMITTED",
			message: `Nobody admitted Parlume from the lobby within ${lobbyMinutes} minutes.`,
		},
	],
	[
		"request_to_join_denied",
		{
			endReason: "NOT_ADMITTED",
			message:
				"The meeting organizer declined Parlume's request to join.",
		},
	],
	[
		"meeting_not_started_waiting_for_host",
		{
			endReason: "NOT_ADMITTED",
			message: "The meeting had not started and nobody let Parlume in.",
		},
	],
	[
		"meeting_ended_before_bot_joined",
		{
			endReason: "NOT_ADMITTED",
			message: "The meeting ended before Parlume was admitted.",
		},
	],
	[
		"meeting_not_found",
		{
			endReason: "START_FAILED",
			message:
				"Teams could not find this meeting. Check the meeting link.",
		},
	],
	[
		"unable_to_connect_to_meeting",
		{
			endReason: "START_FAILED",
			message:
				"Parlume could not connect to the meeting. Check the meeting link.",
		},
	],
	[
		"login_required",
		{
			endReason: "START_FAILED",
			message:
				"This meeting admits only signed-in users. Set up a Teams sign-in for the bot in the Attendee dashboard and choose a sign-in mode in Settings → Meeting assistant.",
		},
	],
	[
		"bot_login_attempt_failed",
		{
			endReason: "START_FAILED",
			message:
				"Parlume's Teams sign-in failed. Check the Microsoft 365 account set up for the bot in the Attendee dashboard.",
		},
	],
	[
		"blocked_by_captcha",
		{
			endReason: "START_FAILED",
			message: "Teams blocked Parlume with a verification challenge.",
		},
	],
]);

const FATAL = new Map<string, string>([
	["out_of_credits", "The Attendee account has run out of credits."],
	["heartbeat_timeout", "Attendee lost contact with the meeting bot."],
	["bot_not_launched", "Attendee could not launch the meeting bot."],
]);

/** A provider code as it may appear in a stored message: letters and `_`. */
function codeText(value: string): string {
	return value.replace(/[^a-z0-9_]/gi, "").slice(0, 64);
}

export function describeParlumeProviderFailure(event: {
	eventType: string | null;
	eventSubType: string | null;
}): ParlumeProviderFailure {
	const subType = event.eventSubType ? codeText(event.eventSubType) : "";
	if (event.eventType === "could_not_join_meeting") {
		return (
			COULD_NOT_JOIN.get(subType) ?? {
				endReason: "START_FAILED",
				message: subType
					? `Parlume could not join the meeting (${subType}).`
					: "Parlume could not join the meeting.",
			}
		);
	}
	return {
		endReason: "PROVIDER_FAILED",
		message:
			FATAL.get(subType) ??
			(subType
				? `Parlume meeting bot failed (${subType}).`
				: GENERIC_FAILURE),
	};
}
