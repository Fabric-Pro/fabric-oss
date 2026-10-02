const MEETING_BAAS_API_URL = "https://api.meetingbaas.com/v2/bots";

export type ParlumeMeetingBotLeaveResult =
	| { kind: "LEAVE_REQUESTED" }
	| { kind: "TERMINAL"; status: "completed" | "failed" };

export interface ParlumeBridgeSettings {
	apiKey: string;
	bridgeUrl: string;
	callbackUrl: string;
	serviceSecret: string;
}

function configured(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
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
 * handed to Meeting BaaS after Fabric has recorded the project and agent
 * binding, so the future media process can authenticate its session before it
 * reads project context.
 */
export function getParlumeBridgeSettings(): ParlumeBridgeSettings | null {
	const apiKey = configured(process.env.PARLUME_MEETING_BAAS_API_KEY);
	const bridgeBaseUrl =
		configured(process.env.PARLUME_BRIDGE_WS_URL) ?? derivedBridgeUrl();
	const callbackBaseUrl =
		configured(process.env.PARLUME_CALLBACK_URL) ?? derivedCallbackUrl();
	const serviceSecret = configured(process.env.AGENT_SERVICE_SECRET);
	if (!apiKey || !bridgeBaseUrl || !callbackBaseUrl || !serviceSecret) {
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
			apiKey,
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

function callbackUrlForSession(callbackUrl: string, sessionId: string): string {
	const url = new URL(callbackUrl);
	url.searchParams.set("sessionId", sessionId);
	return url.toString();
}

// The provider's validation message names the rejected field (a bot name Teams
// refuses, an unknown custom_params key); without it a 400 is undiagnosable
// from Fabric's side. Bounded, and never the request that caused it.
async function providerFailure(response: Response): Promise<Error> {
	let detail = "";
	try {
		const body = (await response.json()) as { message?: unknown };
		if (typeof body.message === "string") {
			detail = ` ${body.message.slice(0, 200)}`;
		}
	} catch {
		// A non-JSON body carries nothing worth relaying.
	}
	return new Error(
		`Meeting BaaS request failed with HTTP ${response.status}.${detail}`,
	);
}

export async function startParlumeMeetingBot(input: {
	settings: ParlumeBridgeSettings;
	sessionId: string;
	meetingUrl: string;
	streamToken: string;
	callbackSecret: string;
}): Promise<string> {
	const bridgeUrl = bridgeUrlForSession(
		input.settings.bridgeUrl,
		input.sessionId,
		input.streamToken,
	);
	const response = await fetch(MEETING_BAAS_API_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-meeting-baas-api-key": input.settings.apiKey,
		},
		body: JSON.stringify({
			bot_name: "Fabric Parlume",
			meeting_url: input.meetingUrl,
			recording_mode: "audio_only",
			allow_multiple_bots: false,
			callback_enabled: true,
			callback_config: {
				url: callbackUrlForSession(
					input.settings.callbackUrl,
					input.sessionId,
				),
				method: "POST",
				secret: input.callbackSecret,
			},
			streaming_enabled: true,
			// Raw audio both ways on one socket: the bot streams the mixed
			// meeting audio to the bridge and plays whatever the bridge sends
			// back. The provider's transcription mode never plays returned
			// audio, so the bridge transcribes the meeting itself.
			streaming_config: {
				mode: "audio",
				output_url: bridgeUrl,
				input_url: bridgeUrl,
				audio_frequency: 24_000,
			},
			// Three minutes unadmitted or alone is the provider's floor for a
			// meeting that never happened. Silence cannot go below five minutes
			// here; the bridge's own idle rule leaves a silent meeting at three.
			timeout_config: {
				waiting_room_timeout: 180,
				no_one_joined_timeout: 180,
				silence_timeout: 300,
			},
		}),
	});

	if (!response.ok) {
		throw await providerFailure(response);
	}

	const body = (await response.json()) as {
		data?: { bot_id?: unknown };
	};
	const botId = body.data?.bot_id;
	if (typeof botId !== "string" || botId.length === 0) {
		throw new Error("Meeting BaaS returned no bot id.");
	}
	return botId;
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
		throw new Error("Parlume media bridge is unavailable.");
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
		throw new Error("Parlume media bridge is unavailable.");
	}
}

/**
 * Posts a message into the meeting chat as the bot. The provider accepts it
 * only while the bot is in the call, and refuses (422) when the meeting has
 * chat disabled; both surface as errors for the caller to report.
 */
export async function sendParlumeMeetingChat(input: {
	settings: ParlumeBridgeSettings;
	providerBotId: string;
	message: string;
}): Promise<void> {
	const response = await fetch(
		`${MEETING_BAAS_API_URL}/${encodeURIComponent(input.providerBotId)}/send-chat-message`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-meeting-baas-api-key": input.settings.apiKey,
			},
			body: JSON.stringify({ message: input.message.slice(0, 4_096) }),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) {
		throw await providerFailure(response);
	}
}

export async function deleteParlumeMeetingBotData(input: {
	settings: ParlumeBridgeSettings;
	providerBotId: string;
}): Promise<void> {
	const response = await fetch(
		`${MEETING_BAAS_API_URL}/${encodeURIComponent(input.providerBotId)}/delete-data`,
		{
			method: "DELETE",
			headers: { "x-meeting-baas-api-key": input.settings.apiKey },
		},
	);
	if (!response.ok) {
		throw await providerFailure(response);
	}
}

export async function leaveParlumeMeetingBot(input: {
	settings: ParlumeBridgeSettings;
	providerBotId: string;
}): Promise<ParlumeMeetingBotLeaveResult> {
	const response = await fetch(
		`${MEETING_BAAS_API_URL}/${encodeURIComponent(input.providerBotId)}/leave`,
		{
			method: "POST",
			headers: { "x-meeting-baas-api-key": input.settings.apiKey },
		},
	);
	if (response.ok) {
		return { kind: "LEAVE_REQUESTED" };
	}
	if (response.status !== 409) {
		throw await providerFailure(response);
	}
	const statusResponse = await fetch(
		`${MEETING_BAAS_API_URL}/${encodeURIComponent(input.providerBotId)}/status`,
		{
			headers: { "x-meeting-baas-api-key": input.settings.apiKey },
		},
	);
	if (!statusResponse.ok) {
		throw await providerFailure(response);
	}
	const body = (await statusResponse.json()) as {
		data?: { bot_id?: unknown; status?: unknown };
	};
	if (
		body.data?.bot_id !== input.providerBotId ||
		(body.data?.status !== "completed" && body.data?.status !== "failed")
	) {
		throw await providerFailure(response);
	}
	return { kind: "TERMINAL", status: body.data.status };
}

export function isTeamsMeetingUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") {
			return false;
		}
		const host = url.hostname.toLowerCase();
		return [
			"teams.microsoft.com",
			"teams.live.com",
			"teams.microsoft.us",
			"teams.microsoft.de",
			"teams.cloud.microsoft",
		].includes(host);
	} catch {
		return false;
	}
}
