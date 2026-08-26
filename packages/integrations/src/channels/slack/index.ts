/**
 * Slack channel adapter (Slice 5b).
 *
 * Lets the unified `/api/webhooks/channels/slack/events` route accept Slack
 * inbound events using the same ChannelAdapter contract as Telegram. Bit-
 * for-bit equivalent to the bespoke `/api/webhooks/slack/events` verifier
 * (which still runs in production for now — this is purely additive).
 *
 * URL-verification challenges and bot/retry filters surface as
 * `not_a_message` so the unified route 200s without dispatching.
 *
 * Outbound `send` reuses the existing `sendSlackMessage` (which resolves a
 * bot token from the WorkflowIntegration table by `teamId`). The unified
 * route looks up credentials by providerKey, so we accept the bot token
 * from `credentials` and bridge into the team-scoped resolver via the
 * `teamId` field that channel callers must pass alongside.
 */

import {
	cleanMentionText,
	normalizeThreadId,
	shouldProcessEvent,
	verifySlackSignature,
} from "../../slack/verification";
import { registerChannel } from "../registry";
import type {
	ChannelAdapter,
	InboundContext,
	OutboundContext,
	SendMessageInput,
	SendMessageResult,
	VerifyOutcome,
} from "../types";

const SLACK_API = "https://slack.com/api";

interface SlackEvent {
	type?: string;
	channel?: string;
	channel_type?: string;
	user?: string;
	text?: string;
	ts?: string;
	thread_ts?: string;
	bot_id?: string;
	subtype?: string;
}

interface SlackEnvelope {
	type?: string;
	event_id?: string;
	team_id?: string;
	event?: SlackEvent;
	challenge?: string;
}

function token(creds: Record<string, unknown> | undefined): string {
	const t = creds?.access_token ?? creds?.bot_token ?? creds?.token;
	if (typeof t !== "string") {
		throw new Error(
			"slack: missing access_token / bot_token in credentials",
		);
	}
	return t;
}

export const slackChannelAdapter: ChannelAdapter = {
	channel: "slack",
	name: "Slack",
	providerKey: "SLACK",

	verifyInbound(ctx: InboundContext, credentials): VerifyOutcome {
		const rawBody =
			typeof ctx.rawBody === "string"
				? ctx.rawBody
				: new TextDecoder().decode(ctx.rawBody);

		// Slack signing-secret check. Mirrors the bespoke route. If no signing
		// secret is configured for this tenant, we surface `invalid` so the
		// unified route rejects rather than silently passes — matches the
		// bespoke route's behavior of blocking unsigned events when
		// SLACK_SIGNING_SECRET is set.
		const signingSecret =
			typeof credentials?.signing_secret === "string"
				? credentials.signing_secret
				: typeof credentials?.SLACK_SIGNING_SECRET === "string"
					? (credentials.SLACK_SIGNING_SECRET as string)
					: process.env.SLACK_SIGNING_SECRET;

		const signature = ctx.headers["x-slack-signature"];
		const timestamp = ctx.headers["x-slack-request-timestamp"];

		// Fail closed in deployed environments (SOC 2 CC6.1): without a signing
		// secret the checks below are skipped, so unsigned inbound would be
		// accepted. NODE_ENV=production on every Vercel/worker deploy — reject
		// there; allow local dev (no secret) for testing.
		if (!signingSecret && process.env.NODE_ENV === "production") {
			return {
				kind: "invalid",
				reason: "no slack signing secret configured",
			};
		}

		if (signingSecret && (!signature || !timestamp)) {
			return {
				kind: "invalid",
				reason: "missing slack signature headers",
			};
		}
		if (
			signingSecret &&
			!verifySlackSignature(signingSecret, signature, timestamp, rawBody)
		) {
			return { kind: "invalid", reason: "slack signature mismatch" };
		}

		let payload: SlackEnvelope;
		try {
			payload =
				(ctx.parsedBody as SlackEnvelope) ??
				(JSON.parse(rawBody) as SlackEnvelope);
		} catch {
			return { kind: "invalid", reason: "body is not JSON" };
		}

		// URL verification handshake — Slack expects `{ challenge }` echoed back.
		if (payload.type === "url_verification") {
			return {
				kind: "not_a_message",
				ack: { challenge: payload.challenge },
			};
		}

		if (payload.type !== "event_callback" || !payload.event) {
			return { kind: "not_a_message" };
		}

		const event = payload.event;
		const eventId = payload.event_id;
		const teamId = payload.team_id;
		if (!eventId || !teamId) {
			return { kind: "not_a_message" };
		}

		// Bot / subtype / no-text filter — same call the bespoke route uses.
		// Drops bot_messages, edits/deletes, and text-less messages so they
		// never reach the monitor or trigger dispatch downstream.
		if (!shouldProcessEvent(event)) {
			return { kind: "not_a_message" };
		}

		// Classify the routable shape so downstream consumers can opt in:
		//   - app_mention / im DM → routable to agent triggers
		//   - plain channel message → ingested by passive monitors only
		// We emit `valid` for all three kinds and surface `messageKind` so the
		// inbound-handler can keep its existing "only mentions and DMs hit
		// agent-trigger dispatch" semantics while letting the channel-monitor
		// fanout see every routable message.
		const isAppMention = event.type === "app_mention";
		const isDm = event.type === "message" && event.channel_type === "im";
		const isChannelMessage =
			event.type === "message" &&
			event.channel_type !== "im" &&
			!isAppMention;

		if (!isAppMention && !isDm && !isChannelMessage) {
			return { kind: "not_a_message" };
		}

		const threadId = normalizeThreadId({
			channel: event.channel || "",
			ts: event.ts || "",
			thread_ts: event.thread_ts,
			channel_type: event.channel_type,
		});

		const cleanedText = cleanMentionText(event.text || "");

		const messageKind:
			| "app_mention"
			| "direct_message"
			| "channel_message" = isAppMention
			? "app_mention"
			: isDm
				? "direct_message"
				: "channel_message";

		return {
			kind: "valid",
			message: {
				externalEventId: eventId,
				// channelId composes team + slack channel so the same chat across
				// workspaces doesn't collide; matches the bespoke uniqueness model.
				channelId: `${teamId}/${threadId.channelId}`,
				threadId: threadId.threadTs ?? "",
				text: cleanedText,
				sender: {
					id: event.user ?? "unknown",
					name: undefined,
				},
				isDirect: threadId.isDm,
				occurredAt: event.ts
					? new Date(Number.parseFloat(event.ts) * 1000).toISOString()
					: new Date().toISOString(),
				raw: payload,
				messageKind,
				teamId,
				subtype: event.subtype,
				botId: event.bot_id,
				providerTs: event.ts,
			},
		};
	},

	async send(
		input: SendMessageInput,
		ctx: OutboundContext,
	): Promise<SendMessageResult> {
		// channelId is `${teamId}/${slackChannelId}` — split it back out.
		const slash = input.channelId.indexOf("/");
		const slackChannel =
			slash >= 0 ? input.channelId.slice(slash + 1) : input.channelId;
		const tok = token(ctx.credentials);

		const body: Record<string, unknown> = {
			channel: slackChannel,
			text: input.text,
		};
		if (input.threadId) {
			body.thread_ts = input.threadId;
		}

		const res = await fetch(`${SLACK_API}/chat.postMessage`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tok}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body),
		});

		const json = (await res.json()) as {
			ok: boolean;
			ts?: string;
			error?: string;
		};
		if (!json.ok) {
			return { ok: false, error: json.error ?? `HTTP ${res.status}` };
		}
		return { ok: true, messageId: json.ts };
	},
};

// Self-register on import (parallel to telegramChannelAdapter).
registerChannel(slackChannelAdapter);
