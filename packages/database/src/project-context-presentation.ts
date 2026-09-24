/**
 * Pure helpers for presenting a project context row to an agent: its display
 * title, the integration it came from, why it has no readable text, and a
 * Unicode-safe page of its body.
 *
 * Shared by the external MCP gateway (`fabric_list_project_contexts` /
 * `fabric_get_project_context`) and the chat engines' live source reads
 * (`fabric_list_project_sources` / `fabric_get_project_source`), so a source
 * reads the same on both surfaces. The export's skip-reason taxonomy uses the
 * conversation-pointer classifier too.
 *
 * Pure leaf: no Prisma, no I/O. Callers that must not load the database
 * barrel at module scope deep-import this file.
 */

/** The subset of a context row these helpers read. Structural on purpose. */
interface ContextRowShape {
	type: string;
	metadata?: unknown;
}

interface ContextPresentationRow extends ContextRowShape {
	sourceTitle?: string | null;
	originalFilename?: string | null;
	extractionStatus?: string | null;
	extractionError?: string | null;
}

/**
 * Chat providers whose channels are registered as `INTEGRATION` pointer rows,
 * mapped to the name a user would recognize. A provider absent from this map
 * is not treated as a conversation: an unrecognized integration with no text
 * is reported as `NOTHING_STORED` rather than guessing at a source system.
 */
const CONVERSATION_SOURCE_SYSTEMS: Record<string, string> = {
	MICROSOFT_TEAMS: "Microsoft Teams",
	TEAMS: "Microsoft Teams",
	SLACK: "Slack",
};

function readMetadataRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * What a linked-conversation pointer row points at.
 *
 * `CHANNEL` is a shared channel — a space a project is a plausible audience
 * for, and the only kind conversation capture monitors. `PRIVATE_CHAT` is a
 * one-to-one or group chat, which the capture path deliberately leaves alone.
 */
type ConversationPointerKind = "CHANNEL" | "PRIVATE_CHAT";

/** A recognized conversation pointer: which system, and which kind. */
interface ConversationPointer {
	sourceSystem: string;
	kind: ConversationPointerKind;
}

/**
 * Classify a linked-conversation pointer row, or `null` when the row is not
 * one.
 *
 * Matches the metadata shape the channel and chat writers persist —
 * `buildTeamsChannelContextMetadata`, `buildTeamsChatContextMetadata` and
 * `buildSlackChannelContextMetadata` — which is
 * `{ provider, chatType?, channelId | chatId, … }` on an `INTEGRATION` row. The
 * conversation identifier is required as well as the provider: a document
 * pulled from a chat provider's file store is an integration, not a
 * conversation, and reporting it as one would trade a vague lie for a
 * confident one.
 *
 * The channel test is `channelId` present AND `chatType` either absent or
 * `"channel"`, in that combination on purpose:
 *
 *   - Teams stamps `chatType: "channel"` beside `teamId`/`channelId`, and
 *     `chatType: "group"` beside `chatId` — the two never overlap.
 *   - Slack writes `channelId` with no `chatType` at all, so an absent
 *     `chatType` next to a channel id means Slack channel, not "unknown".
 *   - Any other `chatType` — `"group"`, Graph's `"oneOnOne"`, a value this
 *     module has not seen — is NOT assumed to be a channel. It falls through
 *     to the `chatId` test, so an unrecognized chat kind is reported as a
 *     private chat rather than as a channel that will be captured one day.
 *     Erring that way keeps the module from promising capture it cannot
 *     deliver, which is the whole point of the split.
 */
export function classifyConversationPointer(
	ctx: ContextRowShape,
): ConversationPointer | null {
	if (ctx.type !== "INTEGRATION") {
		return null;
	}
	const metadata = readMetadataRecord(ctx.metadata);
	if (!metadata) {
		return null;
	}
	const provider =
		typeof metadata.provider === "string"
			? metadata.provider.toUpperCase()
			: null;
	const sourceSystem = provider
		? CONVERSATION_SOURCE_SYSTEMS[provider]
		: undefined;
	if (!sourceSystem) {
		return null;
	}
	const chatType =
		typeof metadata.chatType === "string"
			? metadata.chatType.toLowerCase()
			: null;
	if (
		typeof metadata.channelId === "string" &&
		(chatType === null || chatType === "channel")
	) {
		return { sourceSystem, kind: "CHANNEL" };
	}
	if (typeof metadata.chatId === "string") {
		return { sourceSystem, kind: "PRIVATE_CHAT" };
	}
	return null;
}

/** Context types whose bytes are the point — the extracted text is secondary. */
const BINARY_CONTEXT_TYPES = new Set([
	"FILE",
	"IMAGE",
	"DOCUMENT",
	"SPREADSHEET",
]);

/** Slice by Unicode code point, matching PostgreSQL substring/length. */
export function sliceUnicodeCharacters(
	body: string,
	offset: number,
	maxLength: number,
): { content: string; contentLength: number } {
	const characters = Array.from(body);
	return {
		content: characters.slice(offset, offset + maxLength).join(""),
		contentLength: characters.length,
	};
}

/** Resolve a display title from the columns, then the metadata fallbacks. */
export function resolveContextTitle(ctx: ContextPresentationRow): string {
	if (ctx.sourceTitle) {
		return ctx.sourceTitle;
	}
	const meta = readMetadataRecord(ctx.metadata) ?? {};
	for (const key of ["title", "documentTitle", "sourceTitle", "filename"]) {
		const value = meta[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return ctx.originalFilename || "Untitled context";
}

/** Resolve the integration provider slug, if this context came from one. */
export function resolveContextProvider(
	ctx: ContextPresentationRow,
): string | null {
	const meta = readMetadataRecord(ctx.metadata) ?? {};
	const provider = meta.provider ?? meta.integrationProvider;
	return typeof provider === "string" && provider.length > 0
		? provider
		: null;
}

/**
 * Explain why a context has no readable body, in terms the caller can act
 * on. The INTEGRATION branch is the one that matters most: a linked Teams or
 * Slack conversation is a monitor pointer, so it is marked COMPLETED with an
 * empty `content` forever — its messages are analysed into backlog proposals
 * and never stored on the context. Returning a bare empty string there would
 * read as "the conversation was empty".
 *
 * A one-to-one or group chat gets its own sentence ahead of that one, because
 * the generic wording is false for it: it says the messages *are* captured
 * elsewhere, and for a private chat nothing is captured anywhere. An agent
 * told to look in "separate conversation records" would search for something
 * that does not exist. This matches `PRIVATE_CONVERSATION_EXCLUDED` in the
 * export's taxonomy — one fact, told the same way on both surfaces.
 */
export function resolveContextUnavailableReason(
	ctx: ContextPresentationRow,
	/** Where an uploaded file's original can be read, for the Class A branch. */
	originalFileHint = "read the original via 'originalFile.url'.",
): string {
	const status = ctx.extractionStatus ?? "";

	if (status === "PENDING" || status === "EXTRACTING") {
		return "Extraction is still in progress — retry shortly.";
	}
	if (status === "FAILED") {
		return ctx.extractionError
			? `Extraction failed: ${ctx.extractionError}`
			: "Extraction failed for this source.";
	}
	if (ctx.type === "INTEGRATION") {
		const pointer = classifyConversationPointer(ctx);
		if (pointer?.kind === "PRIVATE_CHAT") {
			return (
				`This source pins a linked ${pointer.sourceSystem} chat. One-to-one and group chats are ` +
				`not captured by design, so no messages are stored for it here — read them in ${pointer.sourceSystem}.`
			);
		}
		return (
			"This source pins a monitored external conversation. Its messages are captured into " +
			"separate conversation records rather than onto the context row, so an empty body " +
			"does not mean an empty conversation."
		);
	}
	if (BINARY_CONTEXT_TYPES.has(ctx.type)) {
		return `No text was extracted from this file — ${originalFileHint}`;
	}
	return "No content is stored for this context.";
}
