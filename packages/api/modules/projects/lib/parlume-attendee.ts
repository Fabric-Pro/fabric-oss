import { createOutboundHostAllowlist } from "@repo/utils/url-security";

/** Attendee's hosted service; an organization can point at its own instance. */
export const DEFAULT_ATTENDEE_BASE_URL = "https://app.attendee.dev";
// The rate of the meeting audio the bot streams to the bridge, which goes on
// to Flux; Deepgram recommends 16 kHz. Replies carry their own rate (24 kHz).
const MEETING_AUDIO_SAMPLE_RATE = 16_000;
// The bot outlives the session's hard stop only if Fabric's own leave never
// lands, and never by more than this.
const MAX_UPTIME_BACKSTOP_SECONDS = 120;
/**
 * How long the bot waits in a Teams lobby to be admitted before it gives up.
 * The provider bills that wait as bot time.
 */
export const PARLUME_LOBBY_WAIT_SECONDS = 600;
const PROVIDER_DETAIL_CHARS = 200;

/**
 * A self-hosted Attendee is a URL an organization admin saves and Fabric
 * fetches with the key on every invite, leave and chat post. Internal
 * destinations are refused unless the operator lists the host here.
 */
export const PARLUME_ATTENDEE_ALLOWED_HOSTS_ENV =
	"PARLUME_ATTENDEE_ALLOWED_HOSTS";
const attendeeOutbound = createOutboundHostAllowlist({
	envVar: PARLUME_ATTENDEE_ALLOWED_HOSTS_ENV,
});

export type ParlumeMeetingBotLeaveResult =
	| { kind: "LEAVE_REQUESTED" }
	| { kind: "TERMINAL"; status: "completed" | "failed" };

/** Fabric's own media bridge and webhook: operator settings, never a tenant's. */
export interface ParlumeBridgeSettings {
	bridgeUrl: string;
	callbackUrl: string;
	serviceSecret: string;
}

export type ParlumeSettingSource = "organization" | "environment";

/** The Attendee project a bot is created on, and how it signs in to Teams. */
export interface ParlumeAttendeeSettings {
	apiKey: string;
	/** Origin, plus a path prefix for a proxied instance; no trailing slash. */
	baseUrl: string;
	teamsLoginMode: ParlumeTeamsLoginMode | null;
	source: ParlumeSettingSource;
}

/** Attendee refused a request; `detail` is its own bounded explanation. */
export class ParlumeProviderError extends Error {
	readonly status: number;
	readonly detail: string | null;

	constructor(status: number, detail: string | null) {
		super(
			`Attendee request failed with HTTP ${status}.${detail ? ` ${detail}` : ""}`,
		);
		this.name = "ParlumeProviderError";
		this.status = status;
		this.detail = detail;
	}
}

/** Fabric's own media bridge refused or did not answer. */
export class ParlumeBridgeUnavailableError extends Error {
	constructor() {
		super("Parlume media bridge is unavailable.");
		this.name = "ParlumeBridgeUnavailableError";
	}
}

interface ParlumeSpeakerUpdate {
	name: string;
	id: string | null;
	timestamp: number;
	isSpeaking: boolean;
}

/** One meeting chat message, relayed from Attendee's webhook to the bridge. */
export interface ParlumeChatMessageRelay {
	id: string;
	text: string;
	senderName: string | null;
	senderId: string | null;
	toBot: boolean;
	timestampMs: number;
}

export const PARLUME_TEAMS_LOGIN_MODES = [
	"always",
	"only_if_required",
] as const;
export type ParlumeTeamsLoginMode = (typeof PARLUME_TEAMS_LOGIN_MODES)[number];

function isTeamsLoginMode(value: string): value is ParlumeTeamsLoginMode {
	return PARLUME_TEAMS_LOGIN_MODES.some((mode) => mode === value);
}

/**
 * `PARLUME_ATTENDEE_TEAMS_LOGIN` signs the bot in with the Microsoft 365
 * account set up on the Attendee project, so it can join meetings and chat
 * that anonymous guests cannot. Unset keeps the anonymous guest. Any other
 * value refuses the invite rather than join in a mode nobody configured.
 */
function environmentTeamsLoginMode(): ParlumeTeamsLoginMode | null {
	const mode = configured(process.env.PARLUME_ATTENDEE_TEAMS_LOGIN);
	if (!mode) {
		return null;
	}
	if (!isTeamsLoginMode(mode)) {
		throw new Error(
			"PARLUME_ATTENDEE_TEAMS_LOGIN must be always or only_if_required.",
		);
	}
	return mode;
}

function configured(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * The base URL in the form every Attendee call is built from, or null when it
 * is not an https URL without credentials, query or fragment. A pasted
 * `/api/v1` suffix is dropped, since Fabric adds it.
 */
export function normalizeAttendeeBaseUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return null;
		}
		const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
		return `${url.origin}${path}`;
	} catch {
		return null;
	}
}

/**
 * Why an Attendee base URL must not be saved or called, or null. The scheme
 * and shape first, then the same internal-destination refusal the search
 * provider endpoints get.
 */
export function getAttendeeBaseUrlBlockReason(value: string): string | null {
	const normalized = normalizeAttendeeBaseUrl(value);
	if (!normalized) {
		return "The Attendee URL must be an https address without a query.";
	}
	return attendeeOutbound.getUnsafeReason(normalized);
}

/**
 * The operator's Attendee project from the environment, or null without a
 * key. `PARLUME_ATTENDEE_BASE_URL` points at a self-hosted instance.
 */
export function getEnvironmentAttendeeSettings(): ParlumeAttendeeSettings | null {
	const apiKey = configured(process.env.PARLUME_ATTENDEE_API_KEY);
	if (!apiKey) {
		return null;
	}
	const baseUrl = configured(process.env.PARLUME_ATTENDEE_BASE_URL);
	const normalized = baseUrl
		? normalizeAttendeeBaseUrl(baseUrl)
		: DEFAULT_ATTENDEE_BASE_URL;
	if (!normalized) {
		throw new Error("PARLUME_ATTENDEE_BASE_URL must be an https URL.");
	}
	return {
		apiKey,
		baseUrl: normalized,
		teamsLoginMode: environmentTeamsLoginMode(),
		source: "environment",
	};
}

function derivedBridgeUrl(): string | null {
	const host = configured(process.env.NEXT_PUBLIC_PARTYKIT_HOST);
	if (!host) {
		return null;
	}
	try {
		const bridge = new URL(host.includes("://") ? host : `wss://${host}`);
		if (bridge.protocol !== "wss:") {
			return null;
		}
		bridge.pathname = `${bridge.pathname.replace(/\/$/, "")}/parties/parlume`;
		bridge.search = "";
		bridge.hash = "";
		return bridge.toString();
	} catch {
		return null;
	}
}

function derivedCallbackUrl(): string | null {
	const appUrl = configured(
		process.env.APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
	);
	if (!appUrl) {
		return null;
	}
	try {
		const callback = new URL("/api/internal/parlume/callback", appUrl);
		return callback.protocol === "https:" ? callback.toString() : null;
	} catch {
		return null;
	}
}

/**
 * The bridge is deliberately an operator setting. Its per-session URL is only
 * handed to Attendee after Fabric has recorded the project and agent binding,
 * so the media bridge can authenticate its session before it reads project
 * context.
 */
export function getParlumeBridgeSettings(): ParlumeBridgeSettings | null {
	const bridgeBaseUrl =
		configured(process.env.PARLUME_BRIDGE_WS_URL) ?? derivedBridgeUrl();
	const callbackBaseUrl =
		configured(process.env.PARLUME_CALLBACK_URL) ?? derivedCallbackUrl();
	const serviceSecret = configured(process.env.AGENT_SERVICE_SECRET);
	if (!bridgeBaseUrl || !callbackBaseUrl || !serviceSecret) {
		return null;
	}

	try {
		const bridge = new URL(bridgeBaseUrl);
		if (bridge.protocol !== "wss:") {
			return null;
		}
		const callback = new URL(callbackBaseUrl);
		if (callback.protocol !== "https:") {
			return null;
		}
		return {
			bridgeUrl: bridge.toString(),
			callbackUrl: callback.toString(),
			serviceSecret,
		};
	} catch {
		return null;
	}
}

function bridgeUrlForSession(
	bridgeUrl: string,
	sessionId: string,
	streamToken: string,
): string {
	const url = new URL(bridgeUrl);
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}`;
	url.searchParams.set("token", streamToken);
	return url.toString();
}

function bridgeControlUrlForSession(
	bridgeUrl: string,
	sessionId: string,
): string {
	const url = new URL(bridgeUrl);
	url.protocol = "https:";
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}`;
	return url.toString();
}

// Attendee signs webhooks with one project-wide secret it shows only in its
// dashboard, so each bot's webhook URL carries its own session secret instead.
function callbackUrlForSession(
	callbackUrl: string,
	sessionId: string,
	callbackSecret: string,
): string {
	const url = new URL(callbackUrl);
	url.searchParams.set("sessionId", sessionId);
	url.searchParams.set("token", callbackSecret);
	return url.toString();
}

function attendeeHeaders(apiKey: string, json = false): Record<string, string> {
	return {
		Authorization: `Token ${apiKey}`,
		...(json ? { "content-type": "application/json" } : {}),
	};
}

function botsUrl(attendee: Pick<ParlumeAttendeeSettings, "baseUrl">): string {
	return `${attendee.baseUrl}/api/v1/bots`;
}

function botUrl(
	attendee: ParlumeAttendeeSettings,
	providerBotId: string,
	action?: string,
): string {
	const bot = `${botsUrl(attendee)}/${encodeURIComponent(providerBotId)}`;
	return action ? `${bot}/${action}` : bot;
}

/**
 * Every Attendee call goes through the outbound guard: a self-hosted base URL
 * is tenant input, and redirects are refused so the key cannot follow one.
 */
function attendeeFetch(url: string, init: RequestInit): Promise<Response> {
	return attendeeOutbound.fetch(url, init);
}

// Attendee answers `{ error }` for a refused request and a per-field object for
// a rejected body; the detail names the field (a bot name Teams refuses, a
// meeting link it cannot parse), and without it a 400 is undiagnosable from
// Fabric's side. Bounded, never the request that caused it, and the key is
// masked should the provider ever quote it.
async function providerFailure(
	response: Response,
	apiKey: string,
): Promise<ParlumeProviderError> {
	let detail: string | null = null;
	try {
		const body: unknown = await response.json();
		if (typeof body === "object" && body !== null) {
			const message =
				"error" in body && typeof body.error === "string"
					? body.error
					: JSON.stringify(body);
			detail = message
				.split(apiKey)
				.join("…")
				.slice(0, PROVIDER_DETAIL_CHARS);
		}
	} catch {
		// A non-JSON body carries nothing worth relaying.
	}
	return new ParlumeProviderError(response.status, detail);
}

function teamsSettings(mode: ParlumeTeamsLoginMode | null) {
	return mode ? { use_login: true, login_mode: mode } : null;
}

export async function startParlumeMeetingBot(input: {
	settings: ParlumeBridgeSettings;
	attendee: ParlumeAttendeeSettings;
	sessionId: string;
	meetingUrl: string;
	streamToken: string;
	callbackSecret: string;
	hardStopAt: Date;
}): Promise<string> {
	const maxUptimeSeconds =
		Math.max(
			1,
			Math.ceil((input.hardStopAt.getTime() - Date.now()) / 1_000),
		) + MAX_UPTIME_BACKSTOP_SECONDS;
	const teams = teamsSettings(input.attendee.teamsLoginMode);
	const response = await attendeeFetch(botsUrl(input.attendee), {
		method: "POST",
		headers: attendeeHeaders(input.attendee.apiKey, true),
		body: JSON.stringify({
			bot_name: "Fabric Parlume",
			meeting_url: input.meetingUrl,
			metadata: { parlume_session_id: input.sessionId },
			deduplication_key: `parlume-${input.sessionId}`,
			// No recording is kept: the bridge transcribes the live audio. Format
			// "none" still runs the realtime audio socket, and the speech events
			// that attribute turns to participants need their flag.
			recording_settings: {
				format: "none",
				record_participant_speech_start_stop_events: true,
			},
			// Raw audio both ways on one socket: Attendee streams the mixed
			// meeting audio to the bridge and plays whatever the bridge sends
			// back. It connects to this URL as given, so the stream token rides in
			// the query.
			websocket_settings: {
				audio: {
					url: bridgeUrlForSession(
						input.settings.bridgeUrl,
						input.sessionId,
						input.streamToken,
					),
					sample_rate: MEETING_AUDIO_SAMPLE_RATE,
				},
			},
			webhooks: [
				{
					url: callbackUrlForSession(
						input.settings.callbackUrl,
						input.sessionId,
						input.callbackSecret,
					),
					// The meeting chat comes back too: participants can type to
					// Parlume, and its own posts showing up confirm delivery.
					triggers: [
						"bot.state_change",
						"participant_events.speech_start_stop",
						"chat_messages.update",
					],
				},
			],
			...(teams ? { teams_settings: teams } : {}),
			// Ten minutes leaves an organizer time to admit the bot; three minutes
			// alone is the floor for a meeting that never happened. Attendee's
			// default silence timeout stays; the bridge's own idle rule leaves a
			// silent meeting at three minutes.
			automatic_leave_settings: {
				waiting_room_timeout_seconds: PARLUME_LOBBY_WAIT_SECONDS,
				only_participant_in_meeting_timeout_seconds: 180,
				max_uptime_seconds: maxUptimeSeconds,
			},
		}),
	});

	if (!response.ok) {
		throw await providerFailure(response, input.attendee.apiKey);
	}

	const body = (await response.json()) as { id?: unknown };
	if (typeof body.id !== "string" || body.id.length === 0) {
		throw new Error("Attendee returned no bot id.");
	}
	return body.id;
}

/**
 * Arms the named Durable Object before a provider bot is created. The room's
 * alarm is therefore independent of a successful WebSocket connection.
 */
export async function armParlumeMeetingBridge(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	hardStopAt: Date;
}): Promise<void> {
	const response = await fetch(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${input.settings.serviceSecret}`,
			},
			body: JSON.stringify({
				hardStopAt: input.hardStopAt.toISOString(),
			}),
		},
	);
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
}

/**
 * Tells the bridge the provider bot is gone, so it closes the transcription
 * socket itself and reports the stream closed. Without this a session whose
 * bot was removed from the meeting waits for a socket close the provider does
 * not always send.
 */
export async function closeParlumeMeetingBridge(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
}): Promise<void> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "close");
	const response = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${input.settings.serviceSecret}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
}

/**
 * Hands the bridge who started or stopped speaking, as Attendee reports it, so
 * the bridge can attribute transcribed turns. Attendee posts these to the
 * webhook, not to the audio socket.
 */
export async function sendParlumeSpeakerUpdates(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	updates: ParlumeSpeakerUpdate[];
}): Promise<void> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "speakers");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${input.settings.serviceSecret}`,
		},
		body: JSON.stringify({ updates: input.updates }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
}

/**
 * Hands the bridge one message from the meeting chat. The bridge stores it
 * with the transcript, matches it against Parlume's own posts, and acts on a
 * request typed to Parlume.
 */
export async function sendParlumeChatMessage(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	message: ParlumeChatMessageRelay;
}): Promise<void> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "chat-message");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${input.settings.serviceSecret}`,
		},
		body: JSON.stringify(input.message),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
}

/**
 * Attendee's Teams bot types a plain-text message one key at a time, about
 * 6 to 7 ms a character, and passes on no meeting audio meanwhile: a long post
 * left Parlume deaf for up to ten seconds. A message with HTML tags is pasted
 * whole, so the text goes as one escaped paragraph.
 */
function parlumeChatHtml(message: string): string {
	// Attendee rejects characters above U+FFFF (emoji); drop them before
	// cutting, so the cut cannot split a surrogate pair.
	const text = message
		.replace(/[\u{10000}-\u{10FFFF}]/gu, "")
		.slice(0, 4_096)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `<p>${text}</p>`;
}

/**
 * Sends a message to the meeting chat as the bot. Attendee only queues it: its
 * Teams bot drops a message silently when the meeting gives it no chat box
 * (an anonymous guest in a channel meeting, or where chat excludes anonymous
 * users), so success here is not delivery. The bridge confirms delivery when
 * the message shows up in the chat. Attendee refuses outright only while the
 * bot is not in the call.
 */
export async function sendParlumeMeetingChat(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
	message: string;
}): Promise<void> {
	const response = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId, "send_chat_message"),
		{
			method: "POST",
			headers: attendeeHeaders(input.attendee.apiKey, true),
			body: JSON.stringify({
				to: "everyone",
				message: parlumeChatHtml(input.message),
			}),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) {
		throw await providerFailure(response, input.attendee.apiKey);
	}
}

export async function deleteParlumeMeetingBotData(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
}): Promise<void> {
	const response = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId, "delete_data"),
		{
			method: "POST",
			headers: attendeeHeaders(input.attendee.apiKey),
		},
	);
	if (!response.ok) {
		throw await providerFailure(response, input.attendee.apiKey);
	}
}

export async function leaveParlumeMeetingBot(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
}): Promise<ParlumeMeetingBotLeaveResult> {
	const response = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId, "leave"),
		{
			method: "POST",
			headers: attendeeHeaders(input.attendee.apiKey),
		},
	);
	if (response.ok) {
		return { kind: "LEAVE_REQUESTED" };
	}
	if (response.status !== 400) {
		throw await providerFailure(response, input.attendee.apiKey);
	}
	// Attendee refuses a leave from any state that cannot leave. A bot that is
	// already leaving or gone is not an error, but only the bot's own state, read
	// back by id, says so.
	const statusResponse = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId),
		{ headers: attendeeHeaders(input.attendee.apiKey) },
	);
	if (!statusResponse.ok) {
		throw await providerFailure(response, input.attendee.apiKey);
	}
	const body = (await statusResponse.json()) as {
		id?: unknown;
		state?: unknown;
	};
	if (body.id === input.providerBotId) {
		switch (body.state) {
			case "leaving":
				return { kind: "LEAVE_REQUESTED" };
			case "post_processing":
			case "ended":
			case "data_deleted":
				return { kind: "TERMINAL", status: "completed" };
			case "fatal_error":
				return { kind: "TERMINAL", status: "failed" };
			default:
				break;
		}
	}
	throw await providerFailure(response, input.attendee.apiKey);
}

export type ParlumeAttendeeCheck =
	| { status: "ok" }
	| { status: "invalid_key"; httpStatus: number }
	| { status: "error"; httpStatus: number | null; detail: string | null };

/**
 * Checks a key against an Attendee instance with its read-only bot list. Opens
 * no bot and costs nothing. The caller has already refused an internal base
 * URL; the guard refuses it again here and on any redirect.
 */
export async function checkAttendeeConnection(input: {
	apiKey: string;
	baseUrl: string;
}): Promise<ParlumeAttendeeCheck> {
	let response: Response;
	try {
		response = await attendeeFetch(botsUrl(input), {
			headers: attendeeHeaders(input.apiKey),
			signal: AbortSignal.timeout(8_000),
		});
	} catch (error) {
		return {
			status: "error",
			httpStatus: null,
			detail:
				error instanceof Error && error.name === "TimeoutError"
					? "Attendee did not answer within 8 seconds."
					: "Attendee could not be reached.",
		};
	}
	if (response.ok) {
		return { status: "ok" };
	}
	if (response.status === 401 || response.status === 403) {
		return { status: "invalid_key", httpStatus: response.status };
	}
	const failure = await providerFailure(response, input.apiKey);
	return {
		status: "error",
		httpStatus: response.status,
		detail: failure.detail,
	};
}

export { isTeamsMeetingUrl } from "./parlume-meeting-url";
