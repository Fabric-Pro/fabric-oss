/**
 * Pure vocabulary for the AI-chat attachment path: which formats it accepts,
 * how the picker advertises them, and the default bounds extraction runs under.
 * No env access here — the server env-override resolver lives in packages/api
 * (see ai-chat-attachment-limits.ts), mirroring `attachment.ts`.
 *
 * This module is deliberately absent from the `@repo/utils` barrel and reachable
 * only via `@repo/utils/ai-chat-attachment`: the barrel statically pulls the
 * template engines, and client consumers must not drag them in. See
 * `index.ts` and package.json `exports["./ai-chat-attachment"]`.
 */

import { extensionForMime } from "./attachment";

/**
 * Text formats read client-side, never sent to the server for extraction.
 *
 * The three-way partition below is load-bearing, not cosmetic: the upload hook
 * asks `isBinaryDocument()` — backed by AI_CHAT_BINARY_DOCUMENT_MIME_TYPES —
 * whether a file goes to the server at all. Collapse these lists into one and
 * text attachments stop being read client-side.
 */
export const AI_CHAT_TEXT_MIME_TYPES: readonly string[] = [
	"text/plain",
	"text/markdown",
	"text/html",
	"application/json",
	// CSV sits here rather than with the binary documents on purpose. Both
	// partitions can extract it — `local-text` already declares the MIME — but
	// only this one is bounded: text formats are read in the browser and pass
	// through `applyAiChatTextBudget`, while the binary path reaches the
	// deliberately-unbounded ingestion extractor. Moving it down there would
	// hand the model a whole 25 MB export.
	"text/csv",
];

/** Binary formats uploaded and extracted server-side. */
export const AI_CHAT_BINARY_DOCUMENT_MIME_TYPES: readonly string[] = [
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	// Legacy .xls (application/vnd.ms-excel) is deliberately absent: exceljs
	// reads xlsx and csv, not BIFF, and no extractor in the repo declares it.
];

/**
 * Image formats a browser can originate. Surfaces may narrow this further (the
 * Feature Assistant does). TIFF is deliberately absent — see below.
 */
export const AI_CHAT_IMAGE_MIME_TYPES: readonly string[] = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
];

/**
 * Formats the server admits but a canvas-compressing client cannot originate.
 *
 * The server's admission list carried `image/tiff` for OCR while the upload
 * hook's did not, which reads like drift and is not: the hook routes anything
 * in the image list through `compressImage`, which decodes via a canvas, and
 * browsers do not decode TIFF. So the exclusion is a capability boundary, not
 * an oversight — the server accepts TIFF from callers that do not compress
 * (Nexus advertises `.tiff` and performs no canvas step), and OCRs it
 * server-side.
 *
 * Admission is the union including these; the picker and the hook's image
 * handling are not. Fold them together and either the server starts rejecting
 * TIFF it accepts today, or the hook hands a TIFF to a canvas that cannot read
 * it.
 */
export const AI_CHAT_SERVER_ONLY_MIME_TYPES: readonly string[] = ["image/tiff"];

/**
 * Whether a browser can decode this image — i.e. whether it may go through
 * canvas compression and be read into a `data:` URL for the model's vision
 * channel.
 *
 * The distinction matters the moment a surface that accepts TIFF starts sharing
 * the Feature Assistant's upload path. That path gates on "is this an image",
 * which is safe only while the caller's format list stops at JPEG and PNG.
 * Widen the list without narrowing the gate and a TIFF is handed to a canvas
 * that cannot decode it, then read into a `data:image/tiff` part that no model
 * accepts — a working upload turns into a rejected model call, and the visible
 * failure is at the API, far from the cause.
 */
export function isClientRenderableAiChatImage(mimeType: string): boolean {
	return AI_CHAT_IMAGE_MIME_TYPES.includes(mimeType);
}

/** Whether this type must be uploaded and read server-side instead. */
export function isServerOnlyAiChatMime(mimeType: string): boolean {
	return AI_CHAT_SERVER_ONLY_MIME_TYPES.includes(mimeType);
}

/**
 * Every MIME the server admits. Wider than what any picker offers: it includes
 * the server-only types above. Extend via env, never hardcode-expand.
 */
export const DEFAULT_AI_CHAT_MIME_ALLOWLIST: readonly string[] = [
	...AI_CHAT_TEXT_MIME_TYPES,
	...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
	...AI_CHAT_IMAGE_MIME_TYPES,
	...AI_CHAT_SERVER_ONLY_MIME_TYPES,
];

/** What a canvas-compressing client can validate and originate. */
export const AI_CHAT_CLIENT_MIME_TYPES: readonly string[] = [
	...AI_CHAT_TEXT_MIME_TYPES,
	...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
	...AI_CHAT_IMAGE_MIME_TYPES,
];

/**
 * Extensions the picker advertises for a MIME, where `attachment.ts`'s 1:1
 * `MIME_EXTENSION` cannot answer. Two gaps force this small map rather than a
 * pure reuse: `MIME_EXTENSION` maps "image/jpeg" -> "jpg" only, while the accept
 * attribute must advertise both `.jpg` and `.jpeg`; and it carries no entry for
 * `application/json`, not being a story-attachment type. Every
 * other type (pdf, docx, xlsx, txt, md, png, gif, webp) is 1:1 and resolves
 * through `extensionForMime`, so no parallel map is declared for them.
 *
 * `text/html` gained a `MIME_EXTENSION` entry in #1684, when it became a
 * story-attachment type, so its override here is now redundant rather than
 * load-bearing — it is kept only so the chat picker's advertised set stays
 * pinned to `.html` alone, independent of the three extensions the
 * *attachment* surfaces accept. `application/json` still has no entry at all,
 * and that is what the override map is now carrying on its own.
 */
const AI_CHAT_ACCEPT_EXTENSION_OVERRIDES: Record<string, readonly string[]> = {
	"image/jpeg": ["jpg", "jpeg"],
	"image/tiff": ["tif", "tiff"],
	"text/html": ["html"],
	"application/json": ["json"],
};

/** Extensions (lowercase, no dot) a MIME is advertised under. Empty when unknown. */
export function extensionsForAiChatMime(mime: string): readonly string[] {
	const override = AI_CHAT_ACCEPT_EXTENSION_OVERRIDES[mime];
	if (override) {
		return override;
	}
	const single = extensionForMime(mime);
	return single ? [single] : [];
}

/**
 * Extensions a client may originate, derived from the client set so the two
 * cannot drift. Deliberately narrower than the server's allowlist: the hook
 * uses this as a filename guard, and admitting `.tif` here would hand a TIFF to
 * the canvas that cannot decode it.
 */
export const AI_CHAT_ALLOWED_EXTENSION_LIST: readonly string[] = Array.from(
	new Set(AI_CHAT_CLIENT_MIME_TYPES.flatMap(extensionsForAiChatMime)),
);

/**
 * Display names for the document formats, for the attach control's tooltip and
 * `aria-label`.
 *
 * Derived rather than written out, because a hand-kept list is what let the
 * label drift from the picker: it advertised "PDF, DOCX, TXT, MD" while the
 * allowlist had also carried HTML and JSON for some time, and adding XLSX to
 * the vocabulary would have silently left it stale again. The label is what a
 * screen reader announces, so a stale one tells a blind user a supported format
 * is unsupported.
 *
 * Binary documents lead, then text formats — the order the previous hand-kept
 * string used, preserved so the sentence reads the same for what it already
 * covered. Image formats are NOT here: they narrow per surface and the caller
 * composes them separately.
 */
export const AI_CHAT_DOCUMENT_FORMAT_LABELS: readonly string[] = [
	...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
	...AI_CHAT_TEXT_MIME_TYPES,
].reduce<string[]>((labels, mime) => {
	const extension = extensionsForAiChatMime(mime)[0];
	if (extension) {
		labels.push(extension.toUpperCase());
	}
	return labels;
}, []);

/** Filename guard for the accepted extensions. Stateless — no `g` flag. */
export const AI_CHAT_ALLOWED_EXTENSIONS: RegExp = new RegExp(
	`\\.(${AI_CHAT_ALLOWED_EXTENSION_LIST.join("|")})$`,
	"i",
);

/**
 * Extensions the *server* admits, including the server-only types.
 *
 * The sibling above is deliberately narrower and must stay that way — a
 * canvas-compressing client cannot originate a TIFF. But a surface that does no
 * canvas step (Nexus, Loom Direct) needs this wider guard, because paste and
 * drop routinely deliver files with an empty `type` and an extension-only
 * fallback built from the narrow list would refuse a `.tiff` those surfaces
 * accept by MIME. Two guards, each matching what its caller can actually
 * handle; one guard would be wrong for one of them.
 */
export const AI_CHAT_SERVER_ALLOWED_EXTENSION_LIST: readonly string[] =
	Array.from(
		new Set(
			DEFAULT_AI_CHAT_MIME_ALLOWLIST.flatMap(extensionsForAiChatMime),
		),
	);

/** Filename guard for everything the server admits. Stateless — no `g` flag. */
export const AI_CHAT_SERVER_ALLOWED_EXTENSIONS: RegExp = new RegExp(
	`\\.(${AI_CHAT_SERVER_ALLOWED_EXTENSION_LIST.join("|")})$`,
	"i",
);

/**
 * Upload byte cap, matching the story-attachment system.
 *
 * This was 10 MB while the byte cap was the only thing between a hostile file
 * and the API process — there was no inflation ceiling, no walk caps, and no
 * deadline. Those all shipped, so the cap no longer carries that weight on its
 * own and can match the other attachment pipeline instead of differing from it
 * for historical reasons. Bytes past this buy parse time, not capability.
 */
export const DEFAULT_AI_CHAT_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Character budget for text handed inline to the model from one attachment. */
export const DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS = 100_000;

/**
 * How far past its own upload cap an archive may declare it will inflate.
 *
 * Expressed as a ratio rather than an absolute so it moves with the cap. It was
 * an absolute (100 MB against a 10 MB cap) and that is precisely the shape that
 * rots: raising the cap alone silently squeezes the headroom a legitimate file
 * has, until a real spreadsheet is refused by a guard written for zip bombs and
 * the user is told their file looks like an attack.
 *
 * Ten is what the original pair encoded, kept deliberately. Text-heavy OOXML
 * parts routinely compress five to fifteen times, so a tighter ratio starts
 * refusing ordinary workbooks.
 */
export const AI_CHAT_MAX_INFLATION_RATIO = 10;

/**
 * Ceiling on bytes an archive may inflate to before extraction aborts.
 *
 * Checked against the size the archive *declares* in its central directory,
 * before anything is inflated — so raising this permits more work later rather
 * than allocating more now, and the walk caps still bound what is actually read.
 */
export const DEFAULT_AI_CHAT_MAX_INFLATED_BYTES =
	DEFAULT_AI_CHAT_MAX_FILE_BYTES * AI_CHAT_MAX_INFLATION_RATIO;

/** Resource bounds for a workbook walk. */
export const DEFAULT_AI_CHAT_MAX_SHEETS = 50;
export const DEFAULT_AI_CHAT_MAX_ROWS = 50_000;
export const DEFAULT_AI_CHAT_MAX_CELLS = 500_000;

/** Wall-clock deadline for a walk, checked inside it — extraction runs inline. */
export const DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS = 10_000;

/**
 * Container signatures. A genuine `.xlsx` is OOXML — a zip archive, so it opens
 * with `PK`. Both an encrypted OOXML workbook and a legacy BIFF `.xls` are OLE
 * compound files instead.
 */
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b]; // "PK"
const OLE_SIGNATURE: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * Leading bytes `classifyAiChatWorkbook` needs — the longest signature above.
 * Callers read at least this many; fewer is safe (it classifies as unreadable
 * rather than throwing), just less discriminating.
 */
export const AI_CHAT_WORKBOOK_SIGNATURE_BYTES = 4;

const XLSX_EXTENSION = "xlsx";
const XLS_EXTENSION = "xls";

/**
 * Outcome of a workbook signature check. Deliberately reason-carrying rather
 * than a boolean: `.xls`, an encrypted workbook, and a corrupt one all fail,
 * and each owes the user a different sentence (R3, R11, R12).
 *
 * The copy itself lives with each caller — this module stays pure vocabulary,
 * so a toast string and a server error message can differ in register without
 * either leaking in here.
 *
 * `accepted` is the single pass state, and it means "nothing here blocks the
 * upload" rather than "verified workbook": a `.pdf` or `.png` accepts because
 * the classifier has nothing to say about it. One pass state is intentional —
 * with two, a caller writing `!== "accepted"` would reject every non-workbook.
 */
export type AiChatWorkbookClassification =
	| "accepted"
	| "legacy-unsupported"
	| "likely-password-protected"
	| "unreadable";

/**
 * Why the walk stopped short. Mirrors the extractor's own private union
 * (`TruncationReason` in `packages/rag/lib/extraction/extractors/local-xlsx.ts`)
 * — it is not exported, and this module must not import from the rag package.
 * The reader in `process-document.ts` validates against this list rather than
 * trusting the string, so a reason added there without a mirror here degrades to
 * `undefined` instead of leaking an unknown value to the UI.
 */
export const AI_CHAT_TRUNCATION_REASONS = [
	"sheets",
	"rows",
	"cells",
	"deadline",
	"budget",
] as const;

export type AiChatTruncationReason =
	(typeof AI_CHAT_TRUNCATION_REASONS)[number];

/**
 * A sheet the extractor actually opened, as the user needs to see it (R10).
 *
 * `hidden` collapses Excel's `hidden` and `veryHidden` states: the disclosure
 * this serves is "you are about to share a tab you cannot see in Excel", and
 * both states mean exactly that.
 */
export interface AiChatExtractedSheet {
	name: string;
	hidden: boolean;
}

/**
 * What the server actually read out of an attachment, as a discriminated state
 * rather than a flag.
 *
 * Deliberately not `string | null` and deliberately not a `truncated: boolean`.
 * Four situations — a full read, a budget-cut read, a file with no readable
 * text, and a file that could not be read at all — need four different sentences
 * and lead to different next steps. Collapsing them into "content or no content"
 * is the blanket-flag mistake documented in
 * `docs/solutions/integration-issues/ai-assistant-codebase-availability-misreport.md`:
 * a message that fans out to several distinct user situations is a latent
 * misleading-message bug.
 *
 * Note this is a *separate dimension* from the upload chip's `status`. `status`
 * answers "did the round-trip complete?"; this answers "what did we read?". A
 * file can upload perfectly and still carry nothing the model can use — that
 * combination is the exact case the old swallowed-null path reported as a clean
 * green chip.
 *
 * The copy lives with each caller — this module stays pure vocabulary. `failed`
 * is the one variant carrying a rendered sentence, because only the server knows
 * whether the cause was a refused container, an inflation ceiling, or a broken
 * pipeline.
 */
export type AiChatExtractionOutcome =
	/** Text was read in full. `sheets` is empty for non-workbook formats. */
	| { status: "extracted"; sheets: readonly AiChatExtractedSheet[] }
	/**
	 * Text was read but cut short by a bound. The model's copy carries a marker
	 * (R7); this tells the user (R8).
	 *
	 * The row/sheet fields are optional because two different producers reach
	 * this state and only one of them has rows. The workbook walk reports which
	 * sheets it stopped inside; the client-side character budget applied to a
	 * `.md` / `.txt` / `.csv` read in the browser has no rows and no sheets to
	 * name, and reports `omittedCharCount` instead. A consumer must therefore
	 * branch on which count is present rather than assume rows.
	 */
	| {
			status: "truncated";
			sheets: readonly AiChatExtractedSheet[];
			reason?: AiChatTruncationReason;
			omittedRowCount?: number;
			truncatedSheetNames?: readonly string[];
			omittedCharCount?: number;
	  }
	/** The file parsed, but yielded no text — e.g. a chart-only workbook (R9). */
	| { status: "empty"; sheets: readonly AiChatExtractedSheet[] }
	/** The file could not be read. `reason` is a rendered, user-facing sentence (R12). */
	| { status: "failed"; reason: string }
	/**
	 * Extraction did not run on this request — the document was already
	 * `PROCESSING` or `READY` from an earlier one, so the procedure returns
	 * before touching the bytes. Distinct from `empty`: nothing was attempted,
	 * so there is nothing to warn about and the UI stays quiet.
	 */
	| { status: "skipped" };

/** Narrow an untrusted extractor-metadata string to a known reason. */
export function isAiChatTruncationReason(
	value: unknown,
): value is AiChatTruncationReason {
	return (
		typeof value === "string" &&
		(AI_CHAT_TRUNCATION_REASONS as readonly string[]).includes(value)
	);
}

/**
 * Result of bounding one attachment's text: what the model receives, and what
 * the chip says about it.
 *
 * `text` and `outcome` travel together on purpose. They are the two halves of
 * the same disclosure — the marker inside `text` is what stops the model
 * reporting an omitted line as absent, and `outcome` is what stops the user
 * believing the whole file was read. Returning only one of them is how those
 * two drift apart.
 */
export interface AiChatTextBudgetResult {
	text: string;
	outcome: AiChatExtractionOutcome;
}

/**
 * Name what the budget dropped, in the text itself.
 *
 * The marker belongs in `text` because that is the only channel the model
 * reads — `outcome` reaches the UI, not the prompt. Shape mirrors the workbook
 * extractor's marker so the two read alike to a model that meets both in one
 * turn.
 */
function buildTextBudgetMarker(
	omittedChars: number,
	totalChars: number,
): string {
	return `${TEXT_BUDGET_MARKER_PREFIX}${omittedChars.toLocaleString("en-US")} of ${totalChars.toLocaleString("en-US")} characters omitted]`;
}

const TEXT_BUDGET_MARKER_PREFIX = "\n\n[Document truncated — ";

/**
 * Whether this text still carries the budget's truncation marker.
 *
 * Exported for callers that CACHE budgeted text and must decide whether a
 * cached copy is complete. Story attachments are the case: their text is
 * extracted once and reused, so a copy cut under a smaller budget would keep
 * being served after an operator raises the limit. Detecting the marker is what
 * lets such a caller re-extract instead of serving a stale fragment forever.
 *
 * Lives beside the builder on purpose — a caller matching the literal string
 * itself would drift the day the wording changes.
 */
export function hasAiChatTextBudgetMarker(text: string): boolean {
	return text.includes(TEXT_BUDGET_MARKER_PREFIX);
}

/**
 * Bound the text of one chat attachment before it reaches the prompt (R1-R3).
 *
 * Pure, and deliberately budget-as-argument rather than budget-as-default-
 * inside-the-extractor: the ingestion path must stay unbounded (R4, and KTD5 in
 * the Excel plan), so the bound lives with the caller that builds a prompt
 * rather than with the code that reads bytes. A caller that wants everything
 * simply does not call this.
 *
 * Slicing happens on UTF-16 code units, so a cut can land between the halves of
 * a surrogate pair. The trailing lone surrogate is dropped rather than shipped:
 * a lone surrogate is not a character, and some tokenizers reject it outright.
 */
export function applyAiChatTextBudget(
	text: string,
	budgetChars: number = DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
): AiChatTextBudgetResult {
	if (text.trim().length === 0) {
		return { text, outcome: { status: "empty", sheets: [] } };
	}

	if (text.length <= budgetChars) {
		return { text, outcome: { status: "extracted", sheets: [] } };
	}

	let kept = text.slice(0, budgetChars);
	const lastCode = kept.charCodeAt(kept.length - 1);
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
		kept = kept.slice(0, -1);
	}

	const omittedCharCount = text.length - kept.length;
	return {
		text: `${kept}${buildTextBudgetMarker(omittedCharCount, text.length)}`,
		outcome: {
			status: "truncated",
			sheets: [],
			reason: "budget",
			omittedCharCount,
		},
	};
}

/**
 * The tag that delimits one attached file inside the prompt.
 *
 * Chosen to have never appeared in this wire format. `attached_documents` is
 * unusable twice over: the user-message renderer strips that exact tag from
 * every bubble, and the document-generator system prompt still instructs the
 * model to treat such blocks as authoritative material the user shared. Nothing
 * has produced that envelope since it was removed, which made the tag reachable
 * only by an attacker — any attached file's text could emit it, inherit an
 * explicit trust instruction, and stay invisible in the sender's own bubble.
 *
 * No attributes: an attributed tag would need its attribute values escaped,
 * which is exactly the character-level escaping this design exists to avoid.
 * The filename travels in the body.
 */
export const AI_CHAT_ATTACHMENT_TAG = "fabric_attachment";
export const AI_CHAT_ATTACHMENT_TAG_OPEN = `<${AI_CHAT_ATTACHMENT_TAG}>`;
const AI_CHAT_ATTACHMENT_TAG_CLOSE = `</${AI_CHAT_ATTACHMENT_TAG}>`;

/**
 * Every form of the delimiter a body could carry.
 *
 * Deliberately wider than a literal `replaceAll` of the opening tag, because
 * the obvious version has holes an attacker reaches first:
 *  - the **closing** form terminates the envelope early, which is a complete
 *    escape from a guard that looks present;
 *  - tag matching is case-insensitive to a model reading loosely, so
 *    `<FABRIC_ATTACHMENT>` forges just as well;
 *  - whitespace inside the angle brackets is tolerated the same way;
 *  - a body that already carries the underscore-suffixed variant would
 *    otherwise collide with a neutralized forgery.
 *
 * The repo has this exact asymmetry today: the stripper beside the
 * `fabric_source_document` neutralizer is `/gi` with `_*`, while the
 * neutralizer itself is a literal. That pair is the thing not to copy.
 */
const AI_CHAT_ATTACHMENT_TAG_PATTERN = new RegExp(
	`<\\s*/?\\s*${AI_CHAT_ATTACHMENT_TAG}_*\\s*>`,
	"gi",
);

/**
 * Mangle one matched delimiter by appending an underscore to the tag name.
 *
 * Always moves *away* from the real delimiter, so no amount of nesting
 * converges back on it — which is the property deletion lacks.
 */
function mangleAttachmentTag(match: string): string {
	return match.replace(
		new RegExp(`(${AI_CHAT_ATTACHMENT_TAG}_*)`, "i"),
		"$1_",
	);
}

/**
 * Every character the prompt builder — or a model reading its output — can read
 * as the start of a new line. Plain `\n` is the obvious one; the rest are line
 * terminators that renderers and tokenizers also break on, so a filename
 * carrying U+2028 gets the same forgery reach as one carrying a plain newline.
 */
const AI_CHAT_LINE_BREAK_CLASS = "[\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029]";

/**
 * The envelope's own markdown scaffolding, forged inside a body.
 *
 * Targeted at the exact headings the prompt builder emits rather than at
 * markdown headings in general. Neutralizing every `#` run would strip the
 * structure out of any attached `.md` file — real content damage, and a worse
 * document for the model to read — while a forgery has to reproduce one of
 * these strings to be mistaken for scaffolding.
 *
 * Anchored to a line start, because a `#` run is only a heading there.
 */
const AI_CHAT_FORGED_SECTION_PATTERN = new RegExp(
	`(^|${AI_CHAT_LINE_BREAK_CLASS})([ \\t]*)#{1,6}(?=[ \\t]+(?:Files Attached This Turn|Attachment \\d+|Reference \\d+|Retrieved Context))`,
	"gi",
);

/**
 * The `[` that opens a forged upload prefix. Matches only when the bracket is
 * actually followed by the envelope's own prefix words, so ordinary bracketed
 * text (`[final] budget`) keeps its brackets.
 */
const AI_CHAT_FORGED_UPLOAD_PREFIX_PATTERN =
	/\[(?=[ \t]*Uploaded[ \t]+(?:Document|Image)[ \t]*:)/gi;

/**
 * Neutralize a document body against the envelope's delimiter set.
 *
 * Mangles, never deletes. Deletion is what makes nested constructions
 * re-emerge: removing the inner tag from `<<fabric_attachment>fabric_attachment>`
 * reassembles a live one. Appending an underscore always moves *away* from the
 * real delimiter, so no amount of nesting converges back on it.
 *
 * Only delimiter-forming sequences are touched. Angle brackets, quotes, and
 * every other byte survive, so an attached HTML, XML, or source file reaches
 * the model intact and an image's data URL stays byte-identical — two LangChain
 * chat nodes extract that line with a regex and promote it to a vision part.
 */
export function neutralizeAiChatAttachmentBody(content: string): string {
	return content
		.replace(AI_CHAT_ATTACHMENT_TAG_PATTERN, mangleAttachmentTag)
		.replace(AI_CHAT_FORGED_SECTION_PATTERN, "$1$2")
		.replace(AI_CHAT_FORGED_UPLOAD_PREFIX_PATTERN, "");
}

/** Line terminators, as a stateful matcher for the filename pass. */
const AI_CHAT_LINE_BREAK_PATTERN = new RegExp(AI_CHAT_LINE_BREAK_CLASS, "g");

/**
 * A markdown heading run a line break in the *filename* would have placed at
 * the start of a line. Broader than the body's guard on purpose: a filename is
 * interpolated mid-line and has no legitimate heading structure to preserve, so
 * there is nothing to lose by neutralizing every run.
 */
const AI_CHAT_FILENAME_HEADING_PATTERN = new RegExp(
	`(${AI_CHAT_LINE_BREAK_CLASS}[ \\t]*)#{1,6}(?=[ \\t])`,
	"g",
);

/**
 * Neutralize a filename against the same delimiter set.
 *
 * Line breaks are the load-bearing fix: the filename is interpolated mid-line,
 * so once it cannot contain a line break it cannot start a heading, and a
 * zero-byte file with a forged `### Attachment 99` in its name adds no section.
 */
export function neutralizeAiChatAttachmentFilename(fileName: string): string {
	return fileName
		.replace(AI_CHAT_FILENAME_HEADING_PATTERN, "$1")
		.replace(AI_CHAT_LINE_BREAK_PATTERN, " ")
		.replace(AI_CHAT_FORGED_UPLOAD_PREFIX_PATTERN, "")
		.replace(AI_CHAT_ATTACHMENT_TAG_PATTERN, mangleAttachmentTag);
}

/**
 * Build the rag-context entry for one attached file — the single place the
 * envelope is constructed, for every surface and for the server-side story-media
 * producer alike (R6).
 *
 * Callers are handed a finished entry rather than `(fileName, content)` on
 * purpose: no call site holds a filename to interpolate, so a new host cannot
 * forget the neutralizer, because it is never given the input the neutralizer
 * protects.
 */
export function buildAiChatAttachmentEntry(
	fileName: string,
	content: string,
): string {
	const safeName = neutralizeAiChatAttachmentFilename(fileName);
	// Images need the markdown-image envelope so vision-capable models get an
	// `image_url` content part rather than base64 under a "Document" label.
	// Discriminating on the data URL rather than the MIME type preserves the
	// exact branch the hosts used before this was centralized. The data URL is
	// passed through untouched — base64 cannot contain a delimiter, and the line
	// has to stay byte-identical for the agents' extractor.
	const inner = content.startsWith("data:")
		? `[Uploaded Image: ${safeName}]\n![${safeName}](${content})`
		: content
			? `[Uploaded Document: ${safeName}]\n${neutralizeAiChatAttachmentBody(content)}`
			: `[Uploaded Document: ${safeName}]`;

	return `${AI_CHAT_ATTACHMENT_TAG_OPEN}\n${inner}\n${AI_CHAT_ATTACHMENT_TAG_CLOSE}`;
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Whether the classifier has anything to say about this filename. Exported so
 * a caller holding a `File` (rather than bytes) knows which files are worth a
 * read — see the upload hook. Backed by the same extensions the classifier
 * branches on, so the two cannot drift.
 */
export function isAiChatWorkbookFilename(filename: string): boolean {
	const extension = extensionOf(filename);
	return extension === XLSX_EXTENSION || extension === XLS_EXTENSION;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	if (bytes.length < signature.length) {
		return false;
	}
	return signature.every((byte, i) => bytes[i] === byte);
}

/**
 * Classify a workbook by its container signature plus its filename.
 *
 * Why the signature and not the parse error: `exceljs` exposes no
 * encrypted-workbook API, so an encrypted workbook and a corrupt one fail
 * identically at the unzip step — the error type cannot tell them apart. The
 * container can. A real `.xlsx` is a zip; an encrypted OOXML file and a legacy
 * `.xls` are OLE compound files.
 *
 * The `.xlsx`-plus-OLE branch is a best guess, not a determination: OLE is the
 * container for *every* legacy Office format (`.doc`, `.ppt`, `.msg`), so a
 * `.doc` renamed to `.xlsx` lands here too. Hence `likely-`, and hence copy
 * that says "likely" rather than asserting.
 *
 * Pure and total — short input classifies as unreadable rather than throwing.
 */
export function classifyAiChatWorkbook(
	leadingBytes: Uint8Array,
	filename: string,
): AiChatWorkbookClassification {
	const extension = extensionOf(filename);

	if (extension === XLSX_EXTENSION) {
		if (startsWith(leadingBytes, ZIP_SIGNATURE)) {
			return "accepted";
		}
		if (startsWith(leadingBytes, OLE_SIGNATURE)) {
			return "likely-password-protected";
		}
		return "unreadable";
	}

	if (extension === XLS_EXTENSION) {
		if (startsWith(leadingBytes, OLE_SIGNATURE)) {
			return "legacy-unsupported";
		}
		return "unreadable";
	}

	// Not a workbook candidate. The classifier does not gate pdf/docx/txt/png.
	return "accepted";
}

/**
 * `accept` attribute for an AI-chat file picker: document extensions, document
 * MIMEs, then image extensions and image MIMEs. `allowedImageTypes` narrows the
 * image segment per surface (the Feature Assistant passes jpeg/png); absent or
 * empty falls back to the full default image set.
 */
export function buildAiChatAcceptAttribute(
	allowedImageTypes?: readonly string[],
): string {
	const images =
		allowedImageTypes && allowedImageTypes.length > 0
			? allowedImageTypes
			: AI_CHAT_IMAGE_MIME_TYPES;
	const documentMimes = [
		...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
		...AI_CHAT_TEXT_MIME_TYPES,
	];
	const dotted = (mimes: readonly string[]): string[] =>
		mimes.flatMap(extensionsForAiChatMime).map((ext) => `.${ext}`);
	return [
		...dotted(documentMimes),
		...documentMimes,
		...dotted(images),
		...images,
	].join(",");
}
