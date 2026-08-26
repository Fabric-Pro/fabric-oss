/**
 * Pure attachment validation helpers shared by the server (authoritative)
 * and the client (advisory pre-validation). No env access here — the server
 * env-override resolver is a sibling module, `attachment-limits.ts`, so this
 * one stays importable by the client. #1702 Part 1.
 */

export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
export const DEFAULT_MAX_ATTACHMENTS_PER_STORY = 20;

/**
 * Retention window for soft-deleted attachments, in days (Fizzy #1749).
 *
 * THE single definition of the approved policy default. The purge activity, the
 * API's bounds validation and the settings UI all import from here; nothing
 * redeclares 90. Deployment-wide overrides come from
 * FABRIC_ATTACHMENT_RETENTION_DAYS, and per-tenant overrides from
 * Project/Organization.attachmentRetentionDays, cascading
 * project -> organization -> this default.
 */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 90;
/** Floor for a tenant override. Below this the nightly scan widens far enough
 *  to degrade the sweep, and #1702's key-reuse argument assumed the purge only
 *  ever touches long-retired rows. */
export const MIN_ATTACHMENT_RETENTION_DAYS = 30;
export const MAX_ATTACHMENT_RETENTION_DAYS = 3650;
/** Grace period after a retention setting changes, before the new (possibly
 *  shorter) window can delete anything. Makes a mistyped window recoverable —
 *  purge is irreversible and there is no restore surface. */
export const ATTACHMENT_RETENTION_GRACE_DAYS = 7;

/**
 * Coerce a configured retention value into a usable window.
 *
 * REJECTS to null — never clamps. A clamp would silently rewrite an operator's
 * value on read while the API refuses to rewrite it on write, and it would
 * break the purge's scan-bound proof, which needs the set of possible effective
 * windows to be exactly {usable stored values} union {server default}.
 *
 * Returns null for absent/unusable input so the CALLER supplies the fallback;
 * this module has no opinion about what the default should be at any given
 * call site.
 */
export function sanitizeRetentionDays(
	raw: number | null | undefined,
): number | null {
	if (raw === null || raw === undefined) {
		return null;
	}
	if (!Number.isInteger(raw)) {
		return null;
	}
	if (
		raw < MIN_ATTACHMENT_RETENTION_DAYS ||
		raw > MAX_ATTACHMENT_RETENTION_DAYS
	) {
		return null;
	}
	return raw;
}

/**
 * Turn a retention settings field's raw text into the value to send, or
 * `undefined` when the entry is not a usable number.
 *
 * Blank (or whitespace) means "inherit" and maps to `null`.
 *
 * `undefined` is NOT cosmetic — it is the whole point. `Number("-")` is `NaN`
 * and `Number("1e400")` is `Infinity`, and BOTH serialize to `null` through
 * JSON. `null` is a *valid* value on this wire meaning "clear the override", so
 * sending either would silently wipe a configured retention window and stamp
 * the change timestamp, re-arming the grace floor for every project inheriting
 * it. The caller must refuse to send instead.
 *
 * `badInput` closes the same hole from the other side, and callers reading from
 * an `<input type="number">` MUST pass it. Such an element reports
 * `value === ""` for an entry it cannot parse while still DISPLAYING the typed
 * text: measured in Chrome, "1e400" stays visible in the box with `value` blank
 * and `validity.badInput` true. Blank reaching this function otherwise means
 * "inherit", so without the flag an unparseable entry is indistinguishable from
 * a deliberate clear — the user sees a number on screen and their configured
 * window is deleted. The text alone cannot recover this; by then the entry is
 * gone.
 *
 * Deliberately does not clamp, round, or check integer-ness: the server is the
 * single validation authority for range and shape, and a browser that quietly
 * rewrote what was typed would disagree with the other settings form. This
 * exists solely to keep an entry that cannot survive the wire off it.
 *
 * Both retention settings forms parse through here rather than each calling
 * `Number()`. Three separate bugs have already come from that duplication.
 */
export function parseRetentionDaysInput(
	raw: string,
	options?: { badInput?: boolean },
): number | null | undefined {
	if (options?.badInput) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed === "") {
		return null;
	}
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Custom vendor MIME for Excalidraw diagram files (.excalidraw is JSON). #1942. */
export const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";

/** ADO-aligned allowlist. Extend via env, never hardcode-expand. */
export const DEFAULT_ATTACHMENT_MIME_ALLOWLIST: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/zip",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"video/mp4",
	"video/quicktime",
	"video/x-msvideo",
	"video/webm",
	// .excalidraw diagram files (JSON). Custom vendor MIME keeps them isolated
	// from generic application/json. #1942.
	"application/vnd.excalidraw+json",
	// .html/.htm/.xhtml documents. One canonical MIME for all three extensions:
	// application/xhtml+xml is deliberately not admitted, because no registered
	// extractor claims it and an admitted-but-unextractable type fails the
	// context pipeline outright. #1684.
	"text/html",
];

export const MIME_EXTENSION: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"application/zip": "zip",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"pptx",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"video/x-msvideo": "avi",
	"video/webm": "webm",
	"application/vnd.excalidraw+json": "excalidraw",
	"text/html": "html",
};

export function extensionForMime(mime: string): string | null {
	return MIME_EXTENSION[mime] ?? null;
}

export function isAllowedMime(
	mime: string,
	allowlist: readonly string[],
): boolean {
	// Fail closed: an empty allowlist rejects everything.
	if (allowlist.length === 0) {
		return false;
	}
	return allowlist.includes(mime);
}

/**
 * Reverse map: file extension (lowercase, no dot) -> canonical allowlisted MIME.
 * Used to rescue uploads whose browser-reported MIME is empty or ambiguous
 * (e.g. .md reported as "" / application/octet-stream). #1778.
 */
export const EXTENSION_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	zip: "application/zip",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	mp4: "video/mp4",
	mov: "video/quicktime",
	avi: "video/x-msvideo",
	webm: "video/webm",
	excalidraw: "application/vnd.excalidraw+json",
	html: "text/html",
	htm: "text/html",
	xhtml: "text/html",
};

/** `accept` attribute value: every supported extension, dotted + comma-joined. */
export const ATTACHMENT_ACCEPT_ATTR: string = Object.keys(EXTENSION_MIME)
	.map((ext) => `.${ext}`)
	.join(",");

/**
 * Narrowed allowlist for the feature-creation attachment flow (#1702 v1):
 * reference documents — .docx, .md, .txt, .xlsx — plus .excalidraw diagrams
 * (#1942). This is a client-flow UX guardrail; the server stays authoritative
 * against DEFAULT_ATTACHMENT_MIME_ALLOWLIST, so a type outside this set is still
 * rejected server-side even if it slips past.
 *
 * `.xlsx` earns a slot because spreadsheets now reach ticket AI context (see
 * `story-attachment-ai-context.ts`). Legacy `.xls` does not: exceljs reads
 * OOXML, not BIFF, so it would attach but never extract.
 */
export const TEXT_ATTACHMENT_MIME_ALLOWLIST: readonly string[] = [
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"text/markdown",
	"text/plain",
	EXCALIDRAW_MIME,
];

/** `accept` value for the create-flow attachment picker: .docx, .xlsx, .md, .txt, .excalidraw. */
export const TEXT_ATTACHMENT_ACCEPT_ATTR = ".docx,.xlsx,.md,.txt,.excalidraw";

/** Attachment designation: LOCKED (Asset, protected) vs UNLOCKED (Context only). */
export type StoryAttachmentDesignation = "LOCKED" | "UNLOCKED";

/** Human-readable byte size: "512 B", "3 KB", "1.4 MB". */
export function humanFileSize(bytes: number): string {
	return bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(0)} KB`
			: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * True iff `text` parses as an Excalidraw document — not merely valid JSON.
 * Requires the stable top-level `type: "excalidraw"` marker plus an `elements`
 * array so a renamed arbitrary JSON file is rejected. Used by the client
 * pre-check and the server-authoritative attachment validator. #1942.
 */
export function isValidExcalidrawContent(text: string): boolean {
	try {
		const parsed = JSON.parse(text);
		return (
			!!parsed &&
			typeof parsed === "object" &&
			(parsed as { type?: unknown }).type === "excalidraw" &&
			Array.isArray((parsed as { elements?: unknown }).elements)
		);
	} catch {
		return false;
	}
}

/**
 * The lowercase extension of a filename, or "" when it carries none.
 *
 * Parsed with `lastIndexOf` rather than `split(".").pop()`, which returns the
 * whole name when there is no dot — that is what would let a file named `html`
 * resolve as HTML. Every surface that falls back to the extension shares this
 * one parse so they cannot disagree about what an extension is.
 */
export function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolve the canonical MIME for an upload. Prefers the browser-reported MIME
 * when it is allowlisted; otherwise falls back to the filename extension so a
 * file whose MIME the browser guesses as "" / octet-stream (common for .md,
 * .csv) still resolves. Fails closed: returns null when neither the MIME nor
 * the extension maps to an allowlisted type. #1778.
 */
export function resolveAttachmentMime(
	filename: string,
	browserMime: string | undefined,
	allowlist: readonly string[],
): string | null {
	const base = (browserMime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (base && isAllowedMime(base, allowlist)) {
		return base;
	}
	const ext = extensionOf(filename);
	const canonical = ext ? EXTENSION_MIME[ext] : undefined;
	if (canonical && isAllowedMime(canonical, allowlist)) {
		return canonical;
	}
	return null;
}

/**
 * Sanitize a user-supplied filename for safe storage + Content-Disposition.
 * Keeps the basename only, strips control chars / CR / LF / NUL / quotes,
 * caps at 255, and never returns empty.
 */
export function sanitizeAttachmentFilename(name: string): string {
	// basename: drop anything before the last path separator
	const base = name.split(/[/\\]/).pop() ?? "";
	// Strip control chars (code <= 31), DEL (127), and double-quotes (the
	// Content-Disposition delimiter). A numeric charCode filter avoids
	// control-char regex literals entirely.
	let kept = "";
	for (const ch of base) {
		const code = ch.codePointAt(0) ?? 0;
		if (code > 31 && code !== 127 && ch !== '"') {
			kept += ch;
		}
	}
	const cleaned = kept.replace(/^\.+/, "").trim().slice(0, 255);
	return cleaned.length > 0 ? cleaned : "file";
}

/**
 * RFC 6266 / 5987 Content-Disposition for an attachment download. Emits an
 * ASCII-safe `filename="…"` plus a UTF-8 `filename*=` so non-ASCII names
 * survive, and so CR/LF/quote injection is impossible (the input is
 * sanitized first, then the ASCII variant strips remaining non-ASCII).
 */
export function buildContentDisposition(filename: string): string {
	const safe = sanitizeAttachmentFilename(filename);
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
	const encoded = encodeURIComponent(safe);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
