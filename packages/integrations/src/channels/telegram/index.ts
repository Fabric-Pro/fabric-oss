/**
 * Telegram channel adapter.
 *
 * Inbound: Telegram Bot API webhooks. Verification uses the
 * `X-Telegram-Bot-Api-Secret-Token` header set when calling `setWebhook` with
 * `secret_token`. We compare it constant-time against the deployment's
 * `TELEGRAM_WEBHOOK_SECRET`, and reject everything in production when that is
 * unset. The secret is never read from a tenant's stored connection: a
 * Telegram update carries no bot id, so nothing in the unauthenticated
 * request can pick the right tenant (Fizzy #2860).
 *
 * Outbound: POST https://api.telegram.org/bot<token>/sendMessage
 *
 * Threading: Telegram doesn't have first-class threads in 1:1 chats. We treat
 * `chat_id` as the channelId and use empty `threadId` for flat conversations,
 * or `message_thread_id` (forum topics in supergroups) when present.
 */

import { timingSafeEqual } from "node:crypto";
import { registerChannel } from "../registry";
import type {
	ChannelAdapter,
	InboundContext,
	OutboundContext,
	SendMessageInput,
	SendMessageResult,
	VerifyOutcome,
} from "../types";

const TELEGRAM_API = "https://api.telegram.org";
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	channel_post?: TelegramMessage;
}

interface TelegramMessage {
	message_id: number;
	date: number;
	chat: { id: number; type: string; title?: string; username?: string };
	from?: {
		id: number;
		is_bot: boolean;
		first_name?: string;
		username?: string;
	};
	text?: string;
	message_thread_id?: number;
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function token(creds: Record<string, unknown> | undefined): string {
	const t = creds?.bot_token ?? creds?.token ?? creds?.access_token;
	if (typeof t !== "string") {
		throw new Error("telegram: missing bot_token in credentials");
	}
	return t;
}

export const telegramChannelAdapter: ChannelAdapter = {
	channel: "telegram",
	name: "Telegram",
	providerKey: "TELEGRAM",

	verifyInbound(ctx: InboundContext): VerifyOutcome {
		// 1. Shared-secret header check. Fail closed in deployed environments
		// (NODE_ENV=production on every deploy), as the Slack adapter does;
		// allow local dev without a secret for testing.
		const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
		if (!expectedSecret && process.env.NODE_ENV === "production") {
			return {
				kind: "invalid",
				reason: "no telegram webhook secret configured",
			};
		}
		if (expectedSecret) {
			const actual = ctx.headers[SECRET_HEADER];
			if (!actual || !constantTimeEqual(actual, expectedSecret)) {
				return { kind: "invalid", reason: "secret-token mismatch" };
			}
		}

		// 2. Parse body.
		let update: TelegramUpdate;
		try {
			update = (ctx.parsedBody ??
				JSON.parse(
					typeof ctx.rawBody === "string"
						? ctx.rawBody
						: new TextDecoder().decode(ctx.rawBody),
				)) as TelegramUpdate;
		} catch {
			return { kind: "invalid", reason: "body is not JSON" };
		}

		const message =
			update.message ?? update.edited_message ?? update.channel_post;
		if (!message || typeof message.text !== "string") {
			// Updates we don't route (callback queries, polls, status, etc.)
			return { kind: "not_a_message" };
		}

		const chatId = String(message.chat.id);
		const threadId = message.message_thread_id
			? String(message.message_thread_id)
			: "";

		return {
			kind: "valid",
			message: {
				externalEventId: String(update.update_id),
				channelId: chatId,
				threadId,
				text: message.text,
				sender: {
					id: String(message.from?.id ?? "unknown"),
					name:
						message.from?.username ??
						message.from?.first_name ??
						undefined,
				},
				isDirect: message.chat.type === "private",
				occurredAt: new Date(message.date * 1000).toISOString(),
				raw: update,
			},
		};
	},

	async send(
		input: SendMessageInput,
		ctx: OutboundContext,
	): Promise<SendMessageResult> {
		const tok = token(ctx.credentials);
		const body: Record<string, unknown> = {
			chat_id: input.channelId,
			text: input.text,
		};
		if (input.threadId) {
			body.message_thread_id = Number(input.threadId);
		}

		const res = await fetch(`${TELEGRAM_API}/bot${tok}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		const json = (await res.json()) as {
			ok: boolean;
			result?: { message_id: number };
			description?: string;
		};

		if (!json.ok) {
			return {
				ok: false,
				error: json.description ?? `HTTP ${res.status}`,
			};
		}
		return { ok: true, messageId: String(json.result?.message_id) };
	},
};

// Self-register on import.
registerChannel(telegramChannelAdapter);
