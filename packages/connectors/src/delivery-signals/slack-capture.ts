/**
 * Internal, read-only Slack adapter for ordinary same-workspace channels.
 * The caller must authorize and pin its own integration, project and grant.
 * Provider cursors are server-held under that grant and the same time window;
 * this adapter does not accept public inputs or create a source grant.
 * No source text belongs in Temporal arguments, logs or project-wide context.
 */
import type { DeliverySignalCaptureRevision } from "./capture-contract";
import {
	DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES,
	DELIVERY_SOURCE_CAPTURE_PAGE_SIZE,
} from "./capture-limits";

const MAX_BYTES = 1_048_576;
const MAX_MEMBER_PAGES = 5;
const MAX_REQUESTS = 9;
const DEADLINE_MS = 15_000;
const SECOND = BigInt(1_000_000_000);
const WEEK = BigInt(604_800) * SECOND;
const encoder = new TextEncoder();

export type SlackDeliveryErrorCode =
	| "INVALID_SLACK_DELIVERY_INPUT"
	| "SLACK_DELIVERY_ACCESS_DENIED"
	| "SLACK_DELIVERY_UNAVAILABLE"
	| "SLACK_DELIVERY_RATE_LIMITED"
	| "SLACK_DELIVERY_RESPONSE_INVALID"
	| "SLACK_DELIVERY_BUDGET_EXCEEDED"
	| "SLACK_DELIVERY_MESSAGE_UNAVAILABLE";

export class SlackDeliveryCaptureError extends Error {
	constructor(readonly code: SlackDeliveryErrorCode) {
		super("Slack source access or capture could not be established.");
		this.name = "SlackDeliveryCaptureError";
	}
}
function refuse(code: SlackDeliveryErrorCode): never {
	throw new SlackDeliveryCaptureError(code);
}

export interface SlackDeliverySourceInput {
	botToken: string;
	userToken: string;
	expectedTeamId: string;
	channelId: string;
	/** Optional only for initial qualification; reads require pinned identities. */
	expectedHumanUserId?: string;
	expectedBotId?: string;
}
export interface SlackDeliverySourceProof {
	teamId: string;
	channelId: string;
	humanUserId: string;
	botId: string;
	botUserId: string;
	/** Optional authorized display text, never used as identity or authority. */
	channelName?: string;
}
export interface SlackDeliveryRequestOptions {
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}
export interface SlackDeliveryPageInput extends SlackDeliverySourceInput {
	expectedHumanUserId: string;
	expectedBotId: string;
	/** Exact decimal Slack timestamps; explicit window no greater than seven days. */
	oldest: string;
	latest: string;
	/** Opaque provider cursor, stored server-side with this exact grant/window. */
	cursor?: string;
}
export interface SlackDeliveryExactMessageInput
	extends Omit<SlackDeliveryPageInput, "cursor"> {
	messageTs: string;
}
export interface SlackDeliveryMessage {
	externalItemId: string;
	revision: DeliverySignalCaptureRevision;
	/** Selected plain text only; external prose remains untrusted evidence. */
	text: string;
	occurredAt: string;
	hasReplies: boolean;
}
export type SlackDeliveryPartialReason =
	| "UNSUPPORTED_SUBTYPE"
	| "UNSUPPORTED_CONTENT"
	| "UNSUPPORTED_BOT_MESSAGE"
	| "OVERSIZED_TEXT"
	| "INVALID_MESSAGE"
	| "PAGINATION_UNAVAILABLE";
export interface SlackDeliveryPage {
	proof: SlackDeliverySourceProof;
	messages: SlackDeliveryMessage[];
	observedAt: string;
	coverage: "ROOT_MESSAGES_ONLY" | "PARTIAL";
	/** Even a complete root page has neither attachments nor thread reply bodies. */
	limitations: readonly ["TEXT_ONLY", "THREAD_REPLIES_NOT_CAPTURED"];
	partialReasons: SlackDeliveryPartialReason[];
	hasMore: boolean;
	nextCursor: string | null;
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function id(value: unknown, prefix: string): value is string {
	return (
		typeof value === "string" &&
		new RegExp(`^[${prefix}][A-Z0-9]{2,63}$`).test(value)
	);
}
function validCursor(value: unknown): value is string {
	return (
		typeof value === "string" && /^[A-Za-z0-9+/_=-]{1,1024}$/.test(value)
	);
}
/** Nanosecond-scaled arithmetic preserves the original decimal revision exactly. */
function decimal(value: unknown): bigint | null {
	if (
		typeof value !== "string" ||
		!/^(0|[1-9]\d{0,11})(\.\d{1,9})?$/.test(value)
	) {
		return null;
	}
	const [whole, fraction = ""] = value.split(".");
	const result = BigInt(whole) * SECOND + BigInt(fraction.padEnd(9, "0"));
	return result <= BigInt(253_402_300_799) * SECOND ? result : null;
}
function validateSource(input: SlackDeliverySourceInput) {
	if (
		![input.botToken, input.userToken].every(
			(token) =>
				typeof token === "string" &&
				token.length > 0 &&
				token.length <= 4096 &&
				!/[\s\p{Cc}]/u.test(token),
		) ||
		input.botToken === input.userToken ||
		!id(input.expectedTeamId, "T") ||
		!id(input.channelId, "CG") ||
		(input.expectedHumanUserId !== undefined &&
			!id(input.expectedHumanUserId, "UW")) ||
		(input.expectedBotId !== undefined && !id(input.expectedBotId, "B"))
	) {
		refuse("INVALID_SLACK_DELIVERY_INPUT");
	}
}
function validatePage(input: SlackDeliveryPageInput) {
	validateSource(input);
	const oldest = decimal(input.oldest);
	const latest = decimal(input.latest);
	if (
		!id(input.expectedHumanUserId, "UW") ||
		!id(input.expectedBotId, "B") ||
		oldest === null ||
		latest === null ||
		latest <= oldest ||
		latest - oldest > WEEK ||
		(input.cursor !== undefined && !validCursor(input.cursor))
	) {
		refuse("INVALID_SLACK_DELIVERY_INPUT");
	}
	return { oldest, latest };
}

type Method =
	| "auth.test"
	| "conversations.info"
	| "conversations.members"
	| "conversations.history";
interface Budget {
	request(
		method: Method,
		token: string,
		fields?: Record<string, string>,
	): Promise<Record<string, unknown>>;
}
const accessErrors = new Set([
	"invalid_auth",
	"not_authed",
	"token_expired",
	"token_revoked",
	"account_inactive",
	"missing_scope",
	"not_in_channel",
	"channel_not_found",
	"no_permission",
	"team_access_not_granted",
	"access_denied",
	"not_allowed_token_type",
]);

async function operation<T>(
	options: SlackDeliveryRequestOptions,
	run: (budget: Budget) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const fetcher = options.fetch ?? globalThis.fetch;
	let requests = 0;
	let bytes = 0;
	async function wait<R>(promise: Promise<R>): Promise<R> {
		if (signal.aborted) {
			refuse("SLACK_DELIVERY_BUDGET_EXCEEDED");
		}
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					abort = () =>
						reject(
							new SlackDeliveryCaptureError(
								"SLACK_DELIVERY_BUDGET_EXCEEDED",
							),
						);
					signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} finally {
			if (abort) {
				signal.removeEventListener("abort", abort);
			}
		}
	}
	try {
		return await run({
			async request(method, token, fields = {}) {
				if (signal.aborted || ++requests > MAX_REQUESTS) {
					refuse("SLACK_DELIVERY_BUDGET_EXCEEDED");
				}
				const response = await wait(
					fetcher(`https://slack.com/api/${method}`, {
						method: "POST",
						redirect: "error",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type":
								"application/x-www-form-urlencoded; charset=utf-8",
						},
						body: new URLSearchParams(fields).toString(),
						signal,
					}),
				);
				if (response.status === 429) {
					refuse("SLACK_DELIVERY_RATE_LIMITED");
				}
				if (!response.ok) {
					refuse("SLACK_DELIVERY_UNAVAILABLE");
				}
				const size = response.headers.get("content-length");
				if (
					size !== null &&
					(!/^\d+$/.test(size) || Number(size) > MAX_BYTES - bytes)
				) {
					void response.body?.cancel().catch(() => {});
					refuse("SLACK_DELIVERY_BUDGET_EXCEEDED");
				}
				if (!response.body) {
					refuse("SLACK_DELIVERY_RESPONSE_INVALID");
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder("utf-8", { fatal: true });
				let text = "";
				let finished = false;
				try {
					while (true) {
						const chunk = await wait(reader.read());
						if (chunk.done) {
							finished = true;
							break;
						}
						bytes += chunk.value.byteLength;
						if (bytes > MAX_BYTES) {
							refuse("SLACK_DELIVERY_BUDGET_EXCEEDED");
						}
						text += decoder.decode(chunk.value, { stream: true });
					}
					text += decoder.decode();
				} finally {
					if (!finished) {
						void reader.cancel().catch(() => {});
					}
					reader.releaseLock();
				}
				let data: Record<string, unknown> | null;
				try {
					data = object(JSON.parse(text));
				} catch {
					refuse("SLACK_DELIVERY_RESPONSE_INVALID");
				}
				if (!data || typeof data.ok !== "boolean") {
					refuse("SLACK_DELIVERY_RESPONSE_INVALID");
				}
				if (!data.ok) {
					refuse(
						data.error === "ratelimited"
							? "SLACK_DELIVERY_RATE_LIMITED"
							: accessErrors.has(data.error as string)
								? "SLACK_DELIVERY_ACCESS_DENIED"
								: "SLACK_DELIVERY_UNAVAILABLE",
					);
				}
				return data;
			},
		});
	} catch (error) {
		if (error instanceof SlackDeliveryCaptureError) {
			throw error;
		}
		refuse(
			signal.aborted
				? "SLACK_DELIVERY_BUDGET_EXCEEDED"
				: "SLACK_DELIVERY_UNAVAILABLE",
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

function ordinaryWorkspaceIdentity(data: Record<string, unknown>) {
	if (
		!id(data.team_id, "T") ||
		!id(data.user_id, "UW") ||
		(data.enterprise_id !== undefined && data.enterprise_id !== null) ||
		(data.is_enterprise_install !== undefined &&
			data.is_enterprise_install !== false)
	) {
		refuse("SLACK_DELIVERY_ACCESS_DENIED");
	}
}

async function qualify(
	input: SlackDeliverySourceInput,
	budget: Budget,
): Promise<SlackDeliverySourceProof> {
	const human = await budget.request("auth.test", input.userToken);
	const bot = await budget.request("auth.test", input.botToken);
	ordinaryWorkspaceIdentity(human);
	ordinaryWorkspaceIdentity(bot);
	if (
		human.bot_id !== undefined ||
		!id(bot.bot_id, "B") ||
		human.team_id !== input.expectedTeamId ||
		bot.team_id !== input.expectedTeamId ||
		human.user_id === bot.user_id ||
		(input.expectedHumanUserId !== undefined &&
			human.user_id !== input.expectedHumanUserId) ||
		(input.expectedBotId !== undefined &&
			bot.bot_id !== input.expectedBotId)
	) {
		refuse("SLACK_DELIVERY_ACCESS_DENIED");
	}
	const response = await budget.request(
		"conversations.info",
		input.botToken,
		{ channel: input.channelId },
	);
	const channel = object(response.channel);
	if (
		!channel ||
		channel.id !== input.channelId ||
		channel.context_team_id !== input.expectedTeamId ||
		channel.is_channel !== true ||
		channel.is_member !== true ||
		typeof channel.is_private !== "boolean" ||
		![
			"is_im",
			"is_mpim",
			"is_shared",
			"is_ext_shared",
			"is_org_shared",
			"is_pending_ext_shared",
			"is_archived",
		].every((key) => channel[key] === false)
	) {
		refuse("SLACK_DELIVERY_ACCESS_DENIED");
	}
	let cursor: string | undefined;
	let member = false;
	const cursors = new Set<string>();
	for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
		const roster = await budget.request(
			"conversations.members",
			input.botToken,
			{
				channel: input.channelId,
				limit: "200",
				...(cursor ? { cursor } : {}),
			},
		);
		if (
			!Array.isArray(roster.members) ||
			roster.members.length > 200 ||
			!roster.members.every((value) => id(value, "UW"))
		) {
			refuse("SLACK_DELIVERY_RESPONSE_INVALID");
		}
		member ||= roster.members.includes(human.user_id as string);
		const metadata = object(roster.response_metadata);
		if (!metadata || typeof metadata.next_cursor !== "string") {
			refuse("SLACK_DELIVERY_RESPONSE_INVALID");
		}
		if (metadata.next_cursor === "") {
			if (!member) {
				refuse("SLACK_DELIVERY_ACCESS_DENIED");
			}
			return {
				teamId: input.expectedTeamId,
				channelId: input.channelId,
				humanUserId: human.user_id as string,
				botId: bot.bot_id,
				botUserId: bot.user_id as string,
				...(typeof channel.name === "string" &&
				channel.name.length > 0 &&
				channel.name.length <= 80 &&
				channel.name.trim() === channel.name &&
				!/\p{Cc}/u.test(channel.name)
					? { channelName: channel.name }
					: {}),
			};
		}
		if (
			!validCursor(metadata.next_cursor) ||
			cursors.has(metadata.next_cursor)
		) {
			refuse("SLACK_DELIVERY_RESPONSE_INVALID");
		}
		cursor = metadata.next_cursor;
		cursors.add(cursor);
	}
	return refuse("SLACK_DELIVERY_BUDGET_EXCEEDED");
}

/** Current human membership plus a bounded bot history probe; not a persisted grant. */
export async function qualifySlackDeliverySource(
	input: SlackDeliverySourceInput,
	options: SlackDeliveryRequestOptions = {},
): Promise<SlackDeliverySourceProof> {
	validateSource(input);
	return operation(options, async (budget) => {
		const proof = await qualify(input, budget);
		const latest = BigInt(Date.now()) * BigInt(1_000_000);
		const oldest = latest > WEEK ? latest - WEEK : BigInt(0);
		const data = await budget.request(
			"conversations.history",
			input.botToken,
			{
				channel: input.channelId,
				limit: "1",
				oldest: (oldest / SECOND).toString(),
				latest: (latest / SECOND).toString(),
				inclusive: "true",
			},
		);
		if (
			!Array.isArray(data.messages) ||
			data.messages.length > 1 ||
			typeof data.has_more !== "boolean"
		) {
			refuse("SLACK_DELIVERY_RESPONSE_INVALID");
		}
		return proof;
	});
}

function selectMessage(
	value: unknown,
	proof: SlackDeliverySourceProof,
	bounds: { oldest: bigint; latest: bigint },
	partial: Set<SlackDeliveryPartialReason>,
): SlackDeliveryMessage | null {
	const message = object(value);
	if (!message) {
		partial.add("INVALID_MESSAGE");
		return null;
	}
	if (message.bot_id === proof.botId) {
		return null;
	}
	if (message.subtype !== undefined) {
		partial.add("UNSUPPORTED_SUBTYPE");
		return null;
	}
	if (message.bot_id !== undefined) {
		partial.add("UNSUPPORTED_BOT_MESSAGE");
		return null;
	}
	const timestamp = decimal(message.ts);
	if (
		timestamp === null ||
		timestamp < bounds.oldest ||
		timestamp > bounds.latest ||
		!id(message.user, "UW") ||
		(message.channel !== undefined &&
			message.channel !== proof.channelId) ||
		(message.team !== undefined && message.team !== proof.teamId) ||
		(message.type !== undefined && message.type !== "message")
	) {
		partial.add("INVALID_MESSAGE");
		return null;
	}
	if (message.thread_ts !== undefined) {
		if (decimal(message.thread_ts) === null) {
			partial.add("INVALID_MESSAGE");
			return null;
		}
		if (message.thread_ts !== message.ts) {
			return null;
		}
	}
	if (
		["files", "attachments"].some(
			(key) =>
				message[key] !== undefined &&
				(!Array.isArray(message[key]) ||
					(message[key] as unknown[]).length > 0),
		) ||
		typeof message.text !== "string" ||
		!message.text.trim()
	) {
		partial.add("UNSUPPORTED_CONTENT");
		return null;
	}
	if (
		message.text.length > DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES ||
		encoder.encode(message.text).byteLength >
			DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES
	) {
		partial.add("OVERSIZED_TEXT");
		return null;
	}
	let revision = message.ts as string;
	if (message.edited !== undefined) {
		const edited = object(message.edited);
		const editTime = decimal(edited?.ts);
		if (editTime === null || editTime < timestamp) {
			partial.add("INVALID_MESSAGE");
			return null;
		}
		revision = edited?.ts as string;
	}
	if (
		message.reply_count !== undefined &&
		(!Number.isSafeInteger(message.reply_count) ||
			(message.reply_count as number) < 0)
	) {
		partial.add("INVALID_MESSAGE");
		return null;
	}
	return {
		externalItemId: message.ts as string,
		revision: { kind: "DECIMAL", value: revision },
		text: message.text,
		occurredAt: new Date(
			Number(timestamp / BigInt(1_000_000)),
		).toISOString(),
		hasReplies:
			typeof message.reply_count === "number" && message.reply_count > 0,
	};
}

async function readPage(
	input: SlackDeliveryPageInput,
	budget: Budget,
	exact?: string,
): Promise<SlackDeliveryPage> {
	const proof = await qualify(input, budget);
	const data = await budget.request("conversations.history", input.botToken, {
		channel: input.channelId,
		oldest: exact ?? input.oldest,
		latest: exact ?? input.latest,
		inclusive: "true",
		limit: exact ? "1" : String(DELIVERY_SOURCE_CAPTURE_PAGE_SIZE),
		...(!exact && input.cursor ? { cursor: input.cursor } : {}),
	});
	if (
		!Array.isArray(data.messages) ||
		data.messages.length >
			(exact ? 1 : DELIVERY_SOURCE_CAPTURE_PAGE_SIZE) ||
		typeof data.has_more !== "boolean"
	) {
		refuse("SLACK_DELIVERY_RESPONSE_INVALID");
	}
	const reasons = new Set<SlackDeliveryPartialReason>();
	const messages: SlackDeliveryMessage[] = [];
	const seen = new Set<string>();
	const bounds = {
		oldest: decimal(input.oldest) as bigint,
		latest: decimal(input.latest) as bigint,
	};
	for (const value of data.messages) {
		const selected = selectMessage(value, proof, bounds, reasons);
		if (selected) {
			if (seen.has(selected.externalItemId)) {
				refuse("SLACK_DELIVERY_RESPONSE_INVALID");
			}
			seen.add(selected.externalItemId);
			messages.push(selected);
		}
	}
	let nextCursor: string | null = null;
	if (data.response_metadata !== undefined) {
		const metadata = object(data.response_metadata);
		if (
			!metadata ||
			typeof metadata.next_cursor !== "string" ||
			(metadata.next_cursor !== "" && !validCursor(metadata.next_cursor))
		) {
			refuse("SLACK_DELIVERY_RESPONSE_INVALID");
		}
		nextCursor = metadata.next_cursor || null;
	}
	if ((data.has_more && !nextCursor) || (!data.has_more && nextCursor)) {
		reasons.add("PAGINATION_UNAVAILABLE");
	}
	if (nextCursor && nextCursor === input.cursor) {
		refuse("SLACK_DELIVERY_RESPONSE_INVALID");
	}
	return {
		proof,
		messages,
		observedAt: new Date().toISOString(),
		coverage: reasons.size ? "PARTIAL" : "ROOT_MESSAGES_ONLY",
		limitations: ["TEXT_ONLY", "THREAD_REPLIES_NOT_CAPTURED"],
		partialReasons: [...reasons],
		hasMore: data.has_more || nextCursor !== null,
		nextCursor,
	};
}

/** Repeats current membership for every page. Never advances a stored cursor. */
export async function readSlackDeliveryPage(
	input: SlackDeliveryPageInput,
	options: SlackDeliveryRequestOptions = {},
): Promise<SlackDeliveryPage> {
	validatePage(input);
	return operation(options, (budget) => readPage(input, budget));
}

/** Missing or unsupported evidence is unavailable, never inferred to be deleted. */
export async function readExactSlackDeliveryMessage(
	input: SlackDeliveryExactMessageInput,
	options: SlackDeliveryRequestOptions = {},
): Promise<SlackDeliveryPage & { message: SlackDeliveryMessage }> {
	const bounds = validatePage(input);
	const timestamp = decimal(input.messageTs);
	if (
		timestamp === null ||
		timestamp < bounds.oldest ||
		timestamp > bounds.latest ||
		"cursor" in input
	) {
		refuse("INVALID_SLACK_DELIVERY_INPUT");
	}
	return operation(options, async (budget) => {
		const page = await readPage(input, budget, input.messageTs);
		const message = page.messages.find(
			(item) => item.externalItemId === input.messageTs,
		);
		if (!message || page.coverage === "PARTIAL" || page.hasMore) {
			refuse("SLACK_DELIVERY_MESSAGE_UNAVAILABLE");
		}
		return { ...page, message };
	});
}
