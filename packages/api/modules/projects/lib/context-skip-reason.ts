/**
 * The skip-reason taxonomy for the project-contexts export (Fizzy #2228).
 *
 * One blended sentence — *"N were skipped (still processing or unavailable)"* —
 * used to stand in for every way a context can fail to reach the archive. It
 * described a terminally failed extraction as in-progress, an empty crawl as
 * unavailable, and, once the item ceiling started truncating rather than
 * refusing (U3), it described a deliberate cut as a processing delay. Each of
 * those is a different fact about a different row, and only one summary line
 * was ever true at a time.
 *
 * This module is the single source of that truth. It is pure: no database
 * handle, no storage handle, no I/O, no Prisma types — a row goes in, a
 * discriminated reason comes out. The manifest writes `describe*` and the API
 * response counts `code`, so the archive a user opens and the summary the app
 * shows can never drift apart.
 *
 * The shape follows the precedent in
 * `docs/solutions/integration-issues/ai-assistant-codebase-availability-misreport.md`:
 * that bug was one boolean derived from the wrong signal collapsing four
 * distinct states into one misleading message, and the fix was exactly this —
 * a pure, precedence-documented state function that unit tests exercise
 * directly. That write-up also records the trap this module exists to avoid:
 * the first attempt changed only the formatter while a second copy of the
 * string lived elsewhere, so the user-facing text went on lying.
 */

import type { ContextDownloadClass } from "./context-download-filename";

/**
 * Every reason a context can be left out of the archive, in the order they
 * are reported to the user. The order is stable and display-facing: the
 * in-app summary renders its lines in this sequence, so two exports of the
 * same project read the same way.
 */
export const CONTEXT_SKIP_REASON_CODES = [
	"NOTHING_STORED",
	"EXTRACTION_FAILED",
	"EXTRACTION_CANCELLED",
	"CONVERSATION_NOT_CAPTURED",
	"PRIVATE_CONVERSATION_EXCLUDED",
	"CRAWL_INDEXED_NO_PAGES",
	"OBJECT_MISSING",
	"STORAGE_READ_FAILED",
	"BEYOND_ITEM_LIMIT",
] as const;

type ContextSkipReasonCode = (typeof CONTEXT_SKIP_REASON_CODES)[number];

/**
 * A skip reason, discriminated on `code`.
 *
 * Both conversation reasons carry the source system because the row is a
 * pointer, not a document: the content lives in Teams or Slack, and a user
 * cannot act on either message without being told where to look.
 *
 * The two are kept apart because they describe opposite futures. A shared
 * channel with no bundles yet is *waiting* — capture is running and the next
 * export may well include it. A one-to-one or group chat is not waiting for
 * anything: capture deliberately does not reach it, so the archive will never
 * contain it however long the user waits. Reporting both as "not captured
 * yet" made the second one a promise the product does not keep.
 */
export type ContextSkipReason =
	/** The row holds no exportable bytes: no object, no text, nothing. */
	| { code: "NOTHING_STORED" }
	/** Extraction reached a terminal failure and produced no text. */
	| { code: "EXTRACTION_FAILED" }
	/** Extraction was cancelled before producing any text. */
	| { code: "EXTRACTION_CANCELLED" }
	/** A linked channel whose conversation has nothing captured against it. */
	| { code: "CONVERSATION_NOT_CAPTURED"; sourceSystem: string }
	/** A linked one-to-one or group chat, which capture never covers. */
	| { code: "PRIVATE_CONVERSATION_EXCLUDED"; sourceSystem: string }
	/** A `PATH_PREFIX` crawl that indexed no pages. */
	| { code: "CRAWL_INDEXED_NO_PAGES" }
	/** A recorded object the store could not produce (a 404 on read). */
	| { code: "OBJECT_MISSING" }
	/** A recorded object whose read failed for any other reason. */
	| { code: "STORAGE_READ_FAILED" }
	/** Cut by the archive's item ceiling; still one single-item download away. */
	| { code: "BEYOND_ITEM_LIMIT" };

/** Counts per reason. Every code is present; absent reasons count zero. */
export type ContextSkipReasonCounts = Record<ContextSkipReasonCode, number>;

/**
 * The subset of a context row this taxonomy reads. Structural on purpose —
 * the same reason as `classifyContext`'s `{ type: string }`: unit tests build
 * these by hand, without Prisma's generated enums or a database.
 */
export interface SkipReasonContextRow {
	type: string;
	s3Path: string | null;
	urlScope: string | null;
	/**
	 * Nullable because free-text rows never run extraction and older rows
	 * predate the column's default. Absent means "nothing to report", never
	 * "not ready" — the export stopped gating on this field in U1.
	 */
	extractionStatus: string | null;
	metadata: unknown;
}

/** Extraction states that will never produce text on their own. */
const EXTRACTION_FAILED_STATUS = "FAILED";
const EXTRACTION_CANCELLED_STATUS = "CANCELLED";

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
export interface ConversationPointer {
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
	ctx: Pick<SkipReasonContextRow, "type" | "metadata">,
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

/**
 * Why this row cannot go into the archive — or `null` when it can.
 *
 * Returning `null` for an exportable row makes this the one place that
 * decides inclusion, so the reason reported can never disagree with the
 * decision taken.
 *
 * Precedence, first match wins:
 *
 *   Class A (binary passthrough)
 *     1. no recorded object            → NOTHING_STORED
 *     otherwise exportable — the bytes flow regardless of extraction state,
 *     which describes text derived from the object, not the object itself.
 *
 *   Class B / C (the exported artifact IS the text)
 *     1. any text at all               → exportable
 *     2. linked shared channel         → CONVERSATION_NOT_CAPTURED
 *        linked one-to-one/group chat  → PRIVATE_CONVERSATION_EXCLUDED
 *     3. crawled (`PATH_PREFIX`) link  → CRAWL_INDEXED_NO_PAGES
 *     4. extraction FAILED             → EXTRACTION_FAILED
 *     5. extraction CANCELLED          → EXTRACTION_CANCELLED
 *     6. otherwise                     → NOTHING_STORED
 *
 * Structural facts (2, 3) outrank pipeline state (4, 5) deliberately. They
 * describe what the row *is* — a pointer at a conversation, a crawl root —
 * and stay true whatever the extraction column says, whereas a status is only
 * ever a claim about a mechanism that may not even apply to the row. Neither
 * ordering can produce a false statement; this one produces the more
 * actionable of the two true ones.
 *
 * No branch reports an in-flight extraction. A row mid-extraction with no
 * text yet has, at this moment, nothing stored — which is what
 * `NOTHING_STORED` says, without claiming the outcome is final.
 */
export function deriveContextSkipReason(input: {
	context: SkipReasonContextRow;
	downloadClass: ContextDownloadClass;
	/**
	 * The text this row would contribute, already resolved by the caller. For
	 * a crawled link that is the markdown assembled from its child pages, not
	 * the row's own (empty) `content` — which is exactly the distinction that
	 * makes `CRAWL_INDEXED_NO_PAGES` meaningful.
	 */
	exportText: string;
}): ContextSkipReason | null {
	const { context, downloadClass, exportText } = input;

	if (downloadClass === "A") {
		return context.s3Path ? null : { code: "NOTHING_STORED" };
	}

	if (exportText.length > 0) {
		return null;
	}

	const pointer = classifyConversationPointer(context);
	if (pointer) {
		return pointer.kind === "CHANNEL"
			? {
					code: "CONVERSATION_NOT_CAPTURED",
					sourceSystem: pointer.sourceSystem,
				}
			: {
					code: "PRIVATE_CONVERSATION_EXCLUDED",
					sourceSystem: pointer.sourceSystem,
				};
	}

	if (context.type === "LINK" && context.urlScope === "PATH_PREFIX") {
		return { code: "CRAWL_INDEXED_NO_PAGES" };
	}

	if (context.extractionStatus === EXTRACTION_FAILED_STATUS) {
		return { code: "EXTRACTION_FAILED" };
	}

	if (context.extractionStatus === EXTRACTION_CANCELLED_STATUS) {
		return { code: "EXTRACTION_CANCELLED" };
	}

	return { code: "NOTHING_STORED" };
}

/**
 * Classify a thrown storage/assembly error. Separate from
 * `deriveContextSkipReason` because it answers a different question — the row
 * had something to export and the read failed — and because the two are
 * reached from different places in the export loop.
 */
export function deriveStorageErrorSkipReason(err: unknown): ContextSkipReason {
	const name = (err as { name?: string } | null | undefined)?.name ?? "";
	const code = (err as { Code?: string } | null | undefined)?.Code ?? "";
	if (name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey") {
		return { code: "OBJECT_MISSING" };
	}
	return { code: "STORAGE_READ_FAILED" };
}

/**
 * The English line the MANIFEST prints for a reason.
 *
 * Plain English rather than an i18n lookup, matching `story-download-manifest`:
 * the manifest is written once, at export time, into a file that outlives the
 * session that produced it, so it carries no locale. The app-facing strings
 * under `projects.contexts.download.skippedReason.*` mirror these.
 */
export function describeContextSkipReason(reason: ContextSkipReason): string {
	switch (reason.code) {
		case "NOTHING_STORED":
			return "No content stored for this item";
		case "EXTRACTION_FAILED":
			return "Text extraction failed — no text was produced";
		case "EXTRACTION_CANCELLED":
			return "Text extraction was cancelled — no text was produced";
		case "CONVERSATION_NOT_CAPTURED":
			return `Linked ${reason.sourceSystem} conversation — no messages captured yet`;
		// No "yet". Capture does not cover one-to-one and group chats, so the
		// only honest thing to tell the reader is that it will not arrive and
		// where the messages actually are. The sentence states the fact and
		// stops — the reasoning behind the exclusion belongs in the product's
		// documentation, not in a manifest line.
		case "PRIVATE_CONVERSATION_EXCLUDED":
			return `Linked ${reason.sourceSystem} chat — one-to-one and group chats are not captured by design; their messages stay in ${reason.sourceSystem}`;
		case "CRAWL_INDEXED_NO_PAGES":
			return "Crawl indexed no pages";
		case "OBJECT_MISSING":
			return "Source object not found in storage";
		case "STORAGE_READ_FAILED":
			return "Storage read failed";
		case "BEYOND_ITEM_LIMIT":
			return "Beyond the batch item limit — download this one individually";
	}
}

/** A zero-filled count for every reason. */
export function emptyContextSkipReasonCounts(): ContextSkipReasonCounts {
	return Object.fromEntries(
		CONTEXT_SKIP_REASON_CODES.map((code) => [code, 0]),
	) as ContextSkipReasonCounts;
}

/**
 * Tally reasons by code. Every code is present in the result, zeros included,
 * so the client filters on the count rather than probing for the key — and so
 * the counts always sum to the number of skipped rows.
 */
export function countContextSkipReasons(
	reasons: ReadonlyArray<ContextSkipReason>,
): ContextSkipReasonCounts {
	const counts = emptyContextSkipReasonCounts();
	for (const reason of reasons) {
		counts[reason.code] += 1;
	}
	return counts;
}
