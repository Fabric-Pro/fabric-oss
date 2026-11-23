import { isRecord } from "./parlume-stream-auth";
import type { ParlumeSuggestionAudience } from "./parlume-suggestions";

const MAX_NOTICE_CHARS = 1_000;
const MAX_PAGE_URL_CHARS = 2_000;

/** What the bridge keeps about its meeting, under the storage key "bridge". */
export interface ParlumeBridgeState {
	sessionId: string;
	botId: string | null;
	hardStopAt: string | null;
	suggestionsEnabled?: boolean;
	/** Absent from a Fabric that predates audiences, whose sessions are all MEETING. */
	suggestionAudience?: ParlumeSuggestionAudience;
	/** The session's Parlume page; absent from a Fabric that does not send it. */
	pageUrl?: string;
}

/** The notice Parlume posts once it is admitted, and the sentence it says when it cannot post. */
export interface ParlumeJoinNotice {
	text: string;
	spoken: string;
}

/** What Fabric answered when it verified the bot's stream. */
interface ParlumeVerifiedStream {
	bridge: ParlumeBridgeState;
	streamGeneration: number;
	/** Null from a Fabric that does not send one. */
	joinNotice: ParlumeJoinNotice | null;
	/** The invitation named someone from outside the organization. */
	externalInvitees: boolean;
	/** Fabric checks each participant; false from a Fabric that does not. */
	checksAttendees: boolean;
}

/** When the meeting reaches its hard stop, in ms; 0 when there is none. */
export function parlumeHardStopMs(
	bridge: Pick<ParlumeBridgeState, "hardStopAt"> | undefined,
): number {
	return bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0;
}

/**
 * Until when Parlume may speak in the meeting: its hard stop, or for good
 * without one; null when the bridge has no meeting.
 */
export function parlumeOpenUntil(
	bridge: ParlumeBridgeState | undefined,
): number | null {
	if (!bridge) {
		return null;
	}
	return bridge.hardStopAt
		? new Date(bridge.hardStopAt).getTime()
		: Number.POSITIVE_INFINITY;
}

function noticeText(value: unknown): string | null {
	return typeof value === "string" &&
		value.trim() &&
		value.length <= MAX_NOTICE_CHARS
		? value
		: null;
}

function isParsableUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

function pageUrl(value: unknown): string | null {
	return typeof value === "string" &&
		value.length <= MAX_PAGE_URL_CHARS &&
		/^https?:\/\//.test(value) &&
		isParsableUrl(value)
		? value
		: null;
}

function parseJoinNotice(value: unknown): ParlumeJoinNotice | null {
	if (!isRecord(value)) {
		return null;
	}
	const text = noticeText(value.text);
	const spoken = noticeText(value.spoken);
	return text && spoken ? { text, spoken } : null;
}

/** Fabric's `verify-stream` answer for this session's bot, or null when it is not a valid one. */
export function parseParlumeVerifiedStream(
	data: unknown,
	stream: { sessionId: string; botId: string },
): ParlumeVerifiedStream | null {
	if (
		!isRecord(data) ||
		data.valid !== true ||
		typeof data.hardStopAt !== "string" ||
		typeof data.streamGeneration !== "number" ||
		!Number.isSafeInteger(data.streamGeneration) ||
		data.streamGeneration < 1
	) {
		return null;
	}
	const page = pageUrl(data.pageUrl);
	return {
		bridge: {
			sessionId: stream.sessionId,
			botId: stream.botId,
			hardStopAt: data.hardStopAt,
			...(page ? { pageUrl: page } : {}),
			suggestionsEnabled: data.suggestionsEnabled === true,
			// TEAM unless Fabric says MEETING or predates audiences.
			suggestionAudience:
				data.suggestionAudience === undefined ||
				data.suggestionAudience === "MEETING"
					? "MEETING"
					: "TEAM",
		},
		streamGeneration: data.streamGeneration,
		joinNotice: parseJoinNotice(data.joinNotice),
		externalInvitees: data.externalInvitees === true,
		checksAttendees: data.checksAttendees === true,
	};
}
