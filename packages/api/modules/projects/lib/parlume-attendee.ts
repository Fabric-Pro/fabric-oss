import { PARLUME_BOT_NAME } from "@repo/utils/parlume-notes";
import { createOutboundHostAllowlist } from "@repo/utils/url-security";
import { parlumeChatHtml, parlumePlainChatHtml } from "./parlume-chat-html";
import { PARLUME_LOBBY_WAIT_SECONDS } from "./parlume-lobby";

/** Attendee's hosted service; an organization can point at its own instance. */
export const DEFAULT_ATTENDEE_BASE_URL = "https://app.attendee.dev";
// The rate of the meeting audio the bot streams to the bridge, which goes on
// to Flux; Deepgram recommends 16 kHz. Replies carry their own rate (24 kHz).
const MEETING_AUDIO_SAMPLE_RATE = 16_000;
// The bot outlives the session's hard stop only if Fabric's own leave never
// lands, and never by more than this.
const MAX_UPTIME_BACKSTOP_SECONDS = 120;
const PROVIDER_DETAIL_CHARS = 200;
// The leaving line is best effort, and the bridge's own calls into Fabric
// that lead to a leave (idle, a failed stream) allow 15 seconds in all.
const PARLUME_LEAVING_NOTICE_TIMEOUT_MS = 4_000;
// The purge is best effort too, and finalization often runs inside one of
// those calls.
const PARLUME_BRIDGE_PURGE_TIMEOUT_MS = 4_000;

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
	/**
	 * The project's Teams login group the bot signs in with; null is
	 * Attendee's default, the project's oldest group. Sent only with a mode.
	 */
	teamsLoginGroup: string | null;
	/**
	 * The project's webhook secret, as Attendee's dashboard shows it (base64).
	 * Attendee signs every webhook with it. When set, an unsigned or wrongly
	 * signed webhook is refused; without it the session's token alone is
	 * checked.
	 */
	webhookSecret: string | null;
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
	/** Fabric took the sender for an external guest; their commands are not acted on. */
	senderExternal?: boolean;
	toBot: boolean;
	timestampMs: number;
}

/**
 * Someone Parlume must not answer in front of joined or left the meeting:
 * an external guest, or anyone Fabric could not confirm.
 */
interface ParlumeGuestUpdate {
	id: string;
	joined: boolean;
}

/**
 * Where Fabric is with checking one participant: `pending` while it looks
 * them up, then done, with the Fabric account of a confirmed project reader
 * (`userId`) or without one for someone who left or was refused. `at` is
 * when Attendee saw the join or leave, so the bridge can tell a delivery
 * repeated after a leave from someone joining again.
 */
interface ParlumePlacement {
	id: string;
	pending: boolean;
	userId?: string;
	at?: number;
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
 * key. `PARLUME_ATTENDEE_BASE_URL` points at a self-hosted instance, and
 * `PARLUME_ATTENDEE_WEBHOOK_SECRET` is the project's webhook secret.
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
		// One operator project serves every organization without its own
		// key, so none of them may pick another's login group on it.
		teamsLoginGroup: null,
		webhookSecret: getEnvironmentAttendeeWebhookSecret(),
		source: "environment",
	};
}

/** The operator's Attendee project's webhook secret, or null. */
export function getEnvironmentAttendeeWebhookSecret(): string | null {
	return configured(process.env.PARLUME_ATTENDEE_WEBHOOK_SECRET);
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

export function bridgeControlUrlForSession(
	bridgeUrl: string,
	sessionId: string,
): string {
	const url = new URL(bridgeUrl);
	url.protocol = "https:";
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}`;
	return url.toString();
}

// Attendee signs every webhook with one secret for the whole project. The
// session's own random token in the URL also ties a delivery to its bot, and
// stops working once the session needs no more deliveries.
function callbackUrlForSession(
	callbackUrl: string,
	sessionId: string,
	callbackToken: string,
): string {
	const url = new URL(callbackUrl);
	url.searchParams.set("sessionId", sessionId);
	url.searchParams.set("token", callbackToken);
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

function teamsSettings(attendee: ParlumeAttendeeSettings) {
	const mode = attendee.teamsLoginMode;
	if (!mode) {
		return null;
	}
	return attendee.teamsLoginGroup
		? {
				use_login: true,
				login_mode: mode,
				login_group_name: attendee.teamsLoginGroup,
			}
		: { use_login: true, login_mode: mode };
}

export async function startParlumeMeetingBot(input: {
	settings: ParlumeBridgeSettings;
	attendee: ParlumeAttendeeSettings;
	sessionId: string;
	meetingUrl: string;
	streamToken: string;
	callbackToken: string;
	hardStopAt: Date;
}): Promise<string> {
	const maxUptimeSeconds =
		Math.max(
			1,
			Math.ceil((input.hardStopAt.getTime() - Date.now()) / 1_000),
		) + MAX_UPTIME_BACKSTOP_SECONDS;
	const teams = teamsSettings(input.attendee);
	const response = await attendeeFetch(botsUrl(input.attendee), {
		method: "POST",
		headers: attendeeHeaders(input.attendee.apiKey, true),
		body: JSON.stringify({
			bot_name: PARLUME_BOT_NAME,
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
			// Attendee would otherwise save the Teams captions as a transcript
			// of its own. The bridge keeps Parlume's transcript, so Attendee
			// transcribes nothing.
			transcription_settings: { enabled: false },
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
						input.callbackToken,
					),
					// The meeting chat comes back too: participants can type to
					// Parlume, and its own posts showing up confirm delivery.
					// Joins and leaves tell Parlume when an external guest is in.
					triggers: [
						"bot.state_change",
						"participant_events.speech_start_stop",
						"participant_events.join_leave",
						"chat_messages.update",
					],
				},
			],
			...(teams ? { teams_settings: teams } : {}),
			// The lobby wait is billed, so it stays short (see
			// PARLUME_LOBBY_WAIT_SECONDS); three minutes alone is the floor for
			// a meeting that never happened. Attendee's default silence timeout
			// stays; the bridge's own idle rule leaves a silent meeting at three
			// minutes.
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
	/** The session's first chat tag number; see `parlumeChatTagStart`. */
	chatTagStart: number;
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
				chatTagStart: input.chatTagStart,
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
 * Tells the bridge Fabric is about to have the bot leave, while the bot can
 * still post: the bridge says once in the meeting chat that the posts this
 * session offered can no longer be played, after `notice`, which says why
 * Parlume is leaving, when there is one. False when the bridge says it could
 * not post the notice.
 */
export async function noteParlumeLeaving(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	notice?: string;
}): Promise<boolean> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "leaving");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${input.settings.serviceSecret}`,
		},
		body: JSON.stringify(input.notice ? { notice: input.notice } : {}),
		signal: AbortSignal.timeout(PARLUME_LEAVING_NOTICE_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
	const body: unknown = await response.json().catch(() => null);
	return !(
		typeof body === "object" &&
		body !== null &&
		"noticed" in body &&
		body.noticed === false
	);
}

/**
 * Asks the bridge to delete what it still holds of a session that is over.
 * `purged` is false when the bridge refused because a stream is still
 * connected; its hard-stop alarm purges it later.
 */
export async function purgeParlumeBridgeStorage(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
}): Promise<{ purged: boolean }> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "purge");
	const response = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${input.settings.serviceSecret}` },
		signal: AbortSignal.timeout(PARLUME_BRIDGE_PURGE_TIMEOUT_MS),
	});
	if (response.status === 409) {
		return { purged: false };
	}
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
	return { purged: true };
}

/** A control a member uses on the Parlume page while the meeting runs. */
export type ParlumeLiveControl =
	| "stop-speech"
	| "pause"
	| "resume"
	| "continue-reading";

/**
 * Stops Parlume's answer, pauses or resumes its listening, or reads the next
 * chapter of a long post, for a member on the Parlume page. `changed` is
 * false when there was nothing to change: no answer to stop, already paused,
 * already listening, or no chapter waiting.
 */
export async function sendParlumeLiveControl(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	control: ParlumeLiveControl;
	actor: { id: string; name: string | null };
}): Promise<{ changed: boolean }> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", input.control);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${input.settings.serviceSecret}`,
		},
		body: JSON.stringify({ actor: input.actor }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new ParlumeBridgeUnavailableError();
	}
	const body: unknown = await response.json();
	return {
		changed:
			typeof body === "object" &&
			body !== null &&
			"changed" in body &&
			body.changed === true,
	};
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
 * Hands the bridge who joined or left, and where Fabric is with checking
 * them. While a guest is in the meeting, or anyone is being checked,
 * Parlume does not speak or answer in the chat. Guests go in `updates`, the
 * one field a bridge older than the checks reads, so for that bridge a
 * check changes nothing.
 */
export async function sendParlumeGuestUpdates(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	updates: ParlumeGuestUpdate[];
	placing: ParlumePlacement[];
}): Promise<void> {
	const url = new URL(
		bridgeControlUrlForSession(input.settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "guests");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${input.settings.serviceSecret}`,
		},
		body: JSON.stringify({
			updates: input.updates,
			placing: input.placing,
		}),
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
 * Whether the session's posts go to a Teams channel thread through Graph
 * rather than to the meeting chat through Attendee.
 */
export function isParlumeChannelChatSession(session: {
	channelId: string | null;
	channelRootMessageId: string | null;
	channelChatStatus: string | null;
}): boolean {
	return Boolean(
		session.channelId ||
			session.channelRootMessageId ||
			(session.channelChatStatus &&
				session.channelChatStatus !== "ATTENDEE" &&
				session.channelChatStatus !== "UNRESOLVED"),
	);
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
	/** A suggestion or the recap: one paragraph, unformatted. */
	plain?: boolean;
}): Promise<void> {
	const response = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId, "send_chat_message"),
		{
			method: "POST",
			headers: attendeeHeaders(input.attendee.apiKey, true),
			body: JSON.stringify({
				to: "everyone",
				message: input.plain
					? parlumePlainChatHtml(input.message)
					: parlumeChatHtml(input.message),
			}),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) {
		throw await providerFailure(response, input.attendee.apiKey);
	}
}

/**
 * How long a notice waits for the bot to be in the call. Attendee refuses a
 * chat message while the bot is still joining or in the lobby.
 */
export const PARLUME_IN_CALL_WAIT_MS = 30_000;
const PARLUME_IN_CALL_POLL_MS = 2_000;
// The bot left or failed: it can post nothing any more.
const GONE_BOT_STATES = new Set([
	"leaving",
	"post_processing",
	"ended",
	"data_deleted",
	"fatal_error",
]);

type ParlumeBotCallState = "in_call" | "gone" | "timeout";

/**
 * Waits, at most `timeoutMs`, for the bot to be in the call, where Attendee
 * lets it post in the meeting chat: every `joined_*` state. A state that
 * cannot be read counts as not yet in the call.
 */
export async function waitForParlumeBotInCall(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
	timeoutMs?: number;
}): Promise<ParlumeBotCallState> {
	const deadline = Date.now() + (input.timeoutMs ?? PARLUME_IN_CALL_WAIT_MS);
	for (;;) {
		const state = await readBotState(input).catch(() => null);
		if (state?.startsWith("joined")) {
			return "in_call";
		}
		if (state && GONE_BOT_STATES.has(state)) {
			return "gone";
		}
		if (Date.now() + PARLUME_IN_CALL_POLL_MS > deadline) {
			return "timeout";
		}
		await new Promise((resolve) =>
			setTimeout(resolve, PARLUME_IN_CALL_POLL_MS),
		);
	}
}

async function readBotState(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
}): Promise<string | null> {
	const response = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId),
		{
			headers: attendeeHeaders(input.attendee.apiKey),
			signal: AbortSignal.timeout(5_000),
		},
	);
	if (!response.ok) {
		return null;
	}
	const body: unknown = await response.json();
	return typeof body === "object" &&
		body !== null &&
		"state" in body &&
		typeof body.state === "string"
		? body.state
		: null;
}

/** A bot action whose answer Parlume does not read: `delete_data`, `output_image`. */
export async function postParlumeBotAction(
	input: { attendee: ParlumeAttendeeSettings; providerBotId: string },
	action: string,
	body?: object,
): Promise<void> {
	const response = await attendeeFetch(
		botUrl(input.attendee, input.providerBotId, action),
		{
			method: "POST",
			headers: attendeeHeaders(input.attendee.apiKey, body !== undefined),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
	);
	if (!response.ok) {
		throw await providerFailure(response, input.attendee.apiKey);
	}
}

export function deleteParlumeMeetingBotData(input: {
	attendee: ParlumeAttendeeSettings;
	providerBotId: string;
}): Promise<void> {
	return postParlumeBotAction(input, "delete_data");
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
