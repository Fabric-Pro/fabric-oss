/**
 * Channel abstraction shared by every conversational surface (Telegram,
 * Discord, Teams, WhatsApp, ...). Slack still runs on its bespoke route in
 * Slice 5a; migration to this abstraction is Slice 5b.
 *
 * The abstraction is intentionally narrow: every adapter speaks
 * `verifyInbound` (HTTP request → NormalizedMessage | null) and `send`
 * (outbound). Thread continuity, dedup, and dispatch live in the unified
 * route + Prisma models, not in adapters.
 */

/** Discriminator string used in Prisma rows and route paths. */
export type ChannelType =
	| "telegram"
	| "slack"
	| "discord"
	| "teams"
	| "whatsapp"
	| "imessage"
	| string;

/** Payload-shape-agnostic message after the adapter has parsed an inbound webhook. */
export interface NormalizedMessage {
	/** Stable per-channel id used for dedup. */
	externalEventId: string;
	/** Channel-side workspace / team / chat identifier. */
	channelId: string;
	/** Thread / topic id within the channel. Empty string if the channel is flat. */
	threadId: string;
	/** Raw text after any channel-specific cleanup (mention strip, etc.). */
	text: string;
	/** Identifies who sent the message. Channel-specific shape. */
	sender: { id: string; name?: string };
	/** True if this is a direct message rather than a channel post. */
	isDirect: boolean;
	/** Timestamp the channel reports for the message. ISO-8601. */
	occurredAt: string;
	/** Pass-through pointer to the raw payload for adapter-specific logic. */
	raw: unknown;
	/**
	 * Kind of message — used by downstream dispatchers to differentiate between
	 * messages addressed at the bot (mentions, DMs) versus passively-observed
	 * channel posts that ingestion features (e.g. channel monitor) want but
	 * agent-trigger dispatch should ignore. Optional for back-compat.
	 */
	messageKind?: "app_mention" | "direct_message" | "channel_message";
	/**
	 * Slack-specific: workspace team_id, surfaced for downstream consumers that
	 * need to look up linked-channel rows (which are keyed on team + channel).
	 * Adapters that don't expose a team concept may leave this undefined.
	 */
	teamId?: string;
	/**
	 * Raw provider-side message subtype (e.g. Slack "message_changed", "bot_message").
	 * Used by ingestion fanout for belt-and-suspenders filtering.
	 */
	subtype?: string;
	/**
	 * Bot identifier set by the provider when the message came from a bot
	 * integration (Slack `bot_id`). Used to prevent agent reply loops from
	 * being ingested back into the monitor.
	 */
	botId?: string;
	/**
	 * Raw provider-side message timestamp string. Slack uses `seconds.microseconds`
	 * zero-padded — preserved verbatim so the seen-message dedup table can store
	 * a value that sorts lexicographically.
	 */
	providerTs?: string;
}

/** Outbound message options. Threading is optional (omit for flat channels). */
export interface SendMessageInput {
	channelId: string;
	threadId?: string;
	text: string;
}

export interface SendMessageResult {
	ok: boolean;
	/** Channel-side message id, if returned. */
	messageId?: string;
	error?: string;
}

/**
 * Verifier outcome:
 *   - `valid`        the request is authentic; pass NormalizedMessage
 *   - `invalid`      reject with 401
 *   - `not_a_message` valid but not an inbound message we route (challenge,
 *     status, retry header, etc.); the route returns 200 immediately
 */
export type VerifyOutcome =
	| { kind: "valid"; message: NormalizedMessage }
	| { kind: "invalid"; reason: string }
	| { kind: "not_a_message"; ack?: unknown };

/** What an adapter receives at verify time. */
export interface InboundContext {
	/** Raw HTTP headers, lowercased keys. */
	headers: Record<string, string>;
	/** Raw body (string or bytes — adapters call adapter-specific decode). */
	rawBody: string | Uint8Array;
	/** Pre-parsed JSON body if the route already parsed it; otherwise undefined. */
	parsedBody?: unknown;
}

/** Resolved credentials for a tenant + channel pair. */
export interface ChannelCredentials {
	/** Bot/user token, opaque to the abstraction. Adapter interprets it. */
	[key: string]: unknown;
}

/** What `send` receives. */
export interface OutboundContext {
	credentials: ChannelCredentials;
	tenantId: string;
}

/**
 * Channel adapter — one per channel kind. Stateless; safe to share across
 * requests. Concrete implementations live in `./{telegram,discord,...}/`.
 */
export interface ChannelAdapter {
	/** Discriminator. Must match the route param + Prisma `channel` field. */
	readonly channel: ChannelType;
	/** Human-readable name for logs / UI. */
	readonly name: string;
	/** Provider enum value used to look up credentials in WorkflowIntegration. */
	readonly providerKey: string;

	verifyInbound(
		ctx: InboundContext,
		credentials?: ChannelCredentials,
	): Promise<VerifyOutcome> | VerifyOutcome;

	send(
		input: SendMessageInput,
		ctx: OutboundContext,
	): Promise<SendMessageResult>;
}
