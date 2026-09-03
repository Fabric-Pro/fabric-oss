/**
 * Pull-direction image ingestion (PM tool → Fabric).
 *
 * When a work item is pulled/imported from an external PM tool, its
 * description can embed images that live behind the tool's authenticated
 * attachment API (e.g. Azure DevOps: `https://dev.azure.com/{org}/_apis/wit/
 * attachments/{guid}`). Those URLs require a PAT/OAuth token the browser can
 * never send, so they render as a broken image icon.
 *
 * This module is the mirror of the push pipeline's image upload
 * (`story-sync-media.ts`): it walks the description, downloads each external
 * image (authenticated via the caller-supplied `fetchAuth`), stores the bytes
 * in Fabric's own storage under the `story-media/{projectId}/{storyId}/` key-
 * space, and rewrites the `<img>` to a Fabric-hosted reference carrying
 * `data-s3-key`. That is exactly the shape the StoryWorkspace reload refresher
 * resolves to a signed URL, so pulled images render natively with no frontend
 * change.
 *
 * The module is provider-agnostic: callers pass `urlFilter` (which URLs to
 * ingest), `fetchAuth` (per-URL download headers), and `deriveKeyId` (a stable
 * id used to build a deterministic S3 key so re-pulling the same item reuses
 * the same object instead of duplicating it). Azure DevOps is wired today via
 * `buildAdoIngestOptions`; Jira / GitLab / Fizzy can supply their own options.
 *
 * Storage I/O is injected through `PulledImageStore` so this file stays free
 * of `@repo/storage` / `@repo/config` and is trivially unit-testable. Wire a
 * real store with `createStoryMediaPullStore()` from `./pull-image-store`.
 */

import { createHash } from "node:crypto";
import { decryptApiKey } from "@repo/utils";

/** S3 keyspace shared with pasted story-media images. */
const STORY_MEDIA_PREFIX = "story-media/";

/** Content types Fabric accepts for story media (mirrors create-media-upload-url). */
const ALLOWED_IMAGE_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};

/** 5 MB — mirrors `MAX_IMAGE_SIZE` in create-media-upload-url. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Non-image file attachment types Fabric accepts on pull (rendered as a
 * download link, not inline). Images are included so a file-style link that
 * happens to point at an image still ingests. Keep in sync with the wider
 * attachment allowlist in `@repo/integrations/shared/attachment-constants`.
 */
const ALLOWED_FILE_TYPES: Record<string, true> = {
	"application/pdf": true,
	"application/msword": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/vnd.ms-excel": true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
	"application/vnd.ms-powerpoint": true,
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
	"text/plain": true,
	"text/csv": true,
	"application/zip": true,
	...ALLOWED_IMAGE_TYPES,
};

/** 25 MB cap for non-image file attachments pulled into Fabric. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Bound how much of an externally-supplied description the backtracking-prone
 * regexes below scan in one pass. Real PM-tool descriptions are far smaller
 * than this; only the leading span is scanned and anything beyond it is left
 * untouched, so a pathological description can't blow up regex compute time.
 * Bounded span: js/polynomial-redos
 */
const MAX_DESCRIPTION_REGEX_SCAN_CHARS = 200_000;

/** Cap for a single attachment display filename before it is sanitized. */
const MAX_ATTACHMENT_NAME_CHARS = 255;

/** Split `text` into a regex-safe bounded head and the untouched remainder. */
function boundedRegexSpan(text: string): { head: string; tail: string } {
	if (text.length <= MAX_DESCRIPTION_REGEX_SCAN_CHARS) {
		return { head: text, tail: "" };
	}
	return {
		head: text.slice(0, MAX_DESCRIPTION_REGEX_SCAN_CHARS),
		tail: text.slice(MAX_DESCRIPTION_REGEX_SCAN_CHARS),
	};
}

/**
 * Storage operations the ingester needs. Implemented by
 * `createStoryMediaPullStore` against `@repo/storage`; faked in tests.
 */
export interface PulledImageStore {
	/** True when an object already exists at `key` (idempotent re-pull). */
	exists(key: string): Promise<boolean>;
	/** Upload bytes to `key` with the given content type. */
	put(key: string, data: Buffer, contentType: string): Promise<void>;
	/** A directly renderable (signed) download URL for `key`. */
	signedUrl(key: string): Promise<string>;
}

export interface IngestPulledImagesParams {
	/** Raw description (HTML and/or markdown) pulled from the PM tool. */
	description: string | null | undefined;
	projectId: string;
	storyId: string;
	store: PulledImageStore;
	/** Per-URL download headers (e.g. ADO PAT Basic auth). */
	fetchAuth?: (url: string) => Record<string, string> | null | undefined;
	/** Which external URLs to ingest. Non-matching URLs are left untouched. */
	urlFilter?: (url: string) => boolean;
	/** Stable id → deterministic key. Falls back to sha1(url) when null. */
	deriveKeyId?: (url: string) => string | null;
	/**
	 * Optional: map the matched URL to the actual fetchable URL — e.g. resolve a
	 * relative GitLab `/uploads/…` or Fizzy `/rails/active_storage/…` path
	 * against the provider's base. Applied only at download time; the rewritten
	 * description never references the original URL, so this never leaks.
	 */
	resolveFetchUrl?: (url: string) => string;
	/** Provider name shown in the failure placeholder. */
	providerLabel?: string;
}

export interface IngestPulledImagesResult {
	description: string | null | undefined;
	/** Freshly downloaded + stored. */
	ingested: number;
	/** Already present in storage — reused, not re-downloaded. */
	reused: number;
	/** Fetch/upload/validation failed — replaced with a placeholder. */
	failed: number;
	/** Not matched or already Fabric-hosted — left as-is. */
	skipped: number;
}

function escapeAttr(value: string): string {
	return value.replace(/"/g, "&quot;");
}

function escapeHtmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function stableId(url: string): string {
	return createHash("sha1").update(url).digest("hex");
}

/** Already points at Fabric's own story-media keyspace? Then leave it alone. */
function isFabricStoryMedia(url: string): boolean {
	return /(?:^|\/)story-media\//.test(url);
}

/** Map a file extension to an allowed image content type, or null. */
function imageTypeForExtension(ext: string | undefined): string | null {
	switch ((ext ?? "").toLowerCase()) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		default:
			return null;
	}
}

/**
 * Infer an image content type from a URL — prefers a `?fileName=` query param
 * (ADO attachment URLs carry it), falls back to the path extension. Used when
 * the download response is `application/octet-stream` or omits a content type,
 * which ADO's attachment endpoint commonly does for valid images.
 */
function inferImageContentTypeFromUrl(url: string): string | null {
	const fileNameMatch = url.match(/[?&]fileName=([^&]+)/i);
	const name = fileNameMatch
		? decodeURIComponent(fileNameMatch[1])
		: url.split(/[?#]/)[0];
	const ext = name.split(".").pop();
	return imageTypeForExtension(ext);
}

/**
 * Last-resort image type detection from the leading "magic" bytes. Authoritative
 * when both the response header and the URL fail to pin a type — the exact case
 * for ADO RE-UPLOADED attachments: the GET returns `application/octet-stream`
 * and the URL carries a useless `?fileName=image-0.bin` (the original filename
 * is lost across a push→pull round-trip), so the bytes are all we have. Returns
 * a content type only for the formats Fabric accepts inline.
 */
function sniffImageContentType(buf: Buffer): string | null {
	if (buf.length < 12) {
		return null;
	}
	// JPEG: FF D8 FF
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47
	) {
		return "image/png";
	}
	// GIF: "GIF8"
	if (
		buf[0] === 0x47 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x38
	) {
		return "image/gif";
	}
	// WebP: "RIFF"…"WEBP"
	if (
		buf.toString("ascii", 0, 4) === "RIFF" &&
		buf.toString("ascii", 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

/** Generic binary content types ADO/Jira may return for valid image bytes. */
function isGenericBinaryType(contentType: string): boolean {
	return (
		contentType === "" ||
		contentType === "application/octet-stream" ||
		contentType === "binary/octet-stream"
	);
}

/** Map a file extension to an allowed attachment content type, or null. */
function fileTypeForExtension(ext: string | undefined): string | null {
	switch ((ext ?? "").toLowerCase()) {
		case "pdf":
			return "application/pdf";
		case "doc":
			return "application/msword";
		case "docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case "xls":
			return "application/vnd.ms-excel";
		case "xlsx":
			return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case "ppt":
			return "application/vnd.ms-powerpoint";
		case "pptx":
			return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case "txt":
			return "text/plain";
		case "csv":
			return "text/csv";
		case "zip":
			return "application/zip";
		default:
			// Fall back to image types so a file-style link to an image works.
			return imageTypeForExtension(ext);
	}
}

/** Infer a file content type from a URL's `?fileName=` param or extension. */
function inferFileContentTypeFromUrl(url: string): string | null {
	const fileNameMatch = url.match(/[?&]fileName=([^&]+)/i);
	const name = fileNameMatch
		? decodeURIComponent(fileNameMatch[1])
		: url.split(/[?#]/)[0];
	const ext = name.split(".").pop();
	return fileTypeForExtension(ext);
}

/** Best-effort display filename from a URL — last path segment, decoded. */
function filenameFromUrl(url: string): string {
	const path = url.split(/[?#]/)[0];
	const seg = path.split("/").pop() || "";
	try {
		return decodeURIComponent(seg);
	} catch {
		return seg;
	}
}

/** Make a filename safe as the last segment of an S3 key + URL path. */
function sanitizeAttachmentName(name: string): string {
	// Bounded span: js/polynomial-redos — a filename never legitimately needs
	// to be KB-scale; capping here keeps the trim regex below off pathological
	// input regardless of what the PM tool sent as the attachment name.
	const capped = name.slice(0, MAX_ATTACHMENT_NAME_CHARS);
	const cleaned = capped
		.trim()
		.replace(/[^\w.-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned || "attachment";
}

function imgHtml(url: string, key: string, alt: string): string {
	const altAttr = alt ? ` alt="${escapeAttr(alt)}"` : "";
	return `<img src="${escapeAttr(url)}" data-s3-key="${escapeAttr(key)}"${altAttr}>`;
}

function placeholderHtml(alt: string, providerLabel?: string): string {
	const from = providerLabel ? ` from ${providerLabel}` : "";
	const altText = alt ? `: ${escapeHtmlText(alt)}` : "";
	return `<p><em>[Image could not be imported${from}${altText}]</em></p>`;
}

/** Fabric-hosted download link for a non-image attachment (carries data-s3-key). */
function linkHtml(url: string, key: string, filename: string): string {
	const name = filename || "attachment";
	return `<a href="${escapeAttr(url)}" data-s3-key="${escapeAttr(key)}" download>${escapeHtmlText(name)}</a>`;
}

function filePlaceholderHtml(name: string, providerLabel?: string): string {
	const from = providerLabel ? ` from ${providerLabel}` : "";
	const nameText = name ? `: ${escapeHtmlText(name)}` : "";
	return `<p><em>[Attachment could not be imported${from}${nameText}]</em></p>`;
}

/**
 * Remove "could not be imported" media placeholders before PUSHING a description
 * back to a PM tool. The pull ingester inserts these (see `placeholderHtml` /
 * `filePlaceholderHtml`) when an image/attachment download fails. If they
 * round-trip back to the source on push they OVERWRITE the original attachment
 * reference there — permanent data loss: the live `/uploads/…` (or equivalent)
 * link in the PM tool is replaced by inert placeholder text, so the attachment
 * can never be re-pulled. Stripping them on push keeps the source intact, so a
 * transient pull failure self-heals on the next pull instead of destroying data.
 *
 * Handles both the raw HTML form the ingester emits (`<p><em>[…]</em></p>`) and
 * the markdown/italic form a frontend HTML→markdown round-trip produces
 * (`*[…]*`, including markdown-escaped brackets `\[…\]`). Surrounding prose is
 * left untouched — only the bracketed placeholder token is removed.
 */
export function stripFailedMediaPlaceholders(description: string): string {
	if (!description) {
		return description;
	}
	// Bounded span: js/polynomial-redos — only the leading span runs through
	// the regexes below; content beyond it is passed through untouched.
	const { head, tail } = boundedRegexSpan(description);
	return (
		head
			// HTML: <p><em>[Image|Attachment could not be imported…]</em></p>
			.replace(
				/<p>\s*<em>\s*\[(?:Image|Attachment) could not be imported[^\]]*\]\s*<\/em>\s*<\/p>/gi,
				"",
			)
			// Markdown italic / escaped / bare: *[…]*, *\[…\]*, \[…\], […]
			.replace(
				/\*?\\?\[(?:Image|Attachment) could not be imported[^\]]*?\\?\]\*?/gi,
				"",
			) + tail
	);
}

/**
 * Download external images referenced in `description`, store them in Fabric,
 * and rewrite the description to Fabric-hosted `<img>` references. Never
 * throws on a single bad image — failures become an inline placeholder so the
 * user never sees a broken icon. Returns the rewritten description and counts.
 */
export async function ingestPulledImages(
	params: IngestPulledImagesParams,
): Promise<IngestPulledImagesResult> {
	const {
		description,
		projectId,
		storyId,
		store,
		fetchAuth,
		urlFilter,
		deriveKeyId,
		resolveFetchUrl,
		providerLabel,
	} = params;

	let ingested = 0;
	let reused = 0;
	let failed = 0;
	let skipped = 0;

	if (!description) {
		return { description, ingested, reused, failed, skipped };
	}

	const keyFor = (url: string): string => {
		const id = deriveKeyId?.(url) || stableId(url);
		return `${STORY_MEDIA_PREFIX}${projectId}/${storyId}/pull-${id}`;
	};

	type Outcome = {
		action: "keep" | "rewrite" | "placeholder";
		html?: string;
	};

	const handle = async (
		src: string,
		label: string,
		mode: "image" | "file",
	): Promise<Outcome> => {
		if (!src || /^data:/i.test(src)) {
			skipped++;
			return { action: "keep" };
		}
		if (isFabricStoryMedia(src)) {
			skipped++;
			return { action: "keep" };
		}
		if (urlFilter && !urlFilter(src)) {
			skipped++;
			return { action: "keep" };
		}

		const fileLabel = label || filenameFromUrl(src);
		// Files: append the original filename as the key's last segment so the
		// signed-URL path ends with it and the browser names the download
		// correctly (S3 has no Content-Disposition here). Images stay `pull-{id}`.
		const key =
			mode === "file"
				? `${keyFor(src)}/${sanitizeAttachmentName(fileLabel)}`
				: keyFor(src);
		const rewrite = (url: string): string =>
			mode === "image"
				? imgHtml(url, key, label)
				: linkHtml(url, key, fileLabel);
		const placeholder = (reason: string): Outcome => {
			failed++;
			// Surface WHY a media item dropped to a placeholder — these paths
			// were previously silent, which made round-trip breakage (ADO WI
			// #226/#227 images) impossible to diagnose from logs.
			console.warn(
				"[pull-image-ingest] media import failed → placeholder",
				{
					mode,
					providerLabel,
					label,
					src,
					fetchUrl: resolveFetchUrl?.(src) || src,
					reason,
				},
			);
			return {
				action: "placeholder",
				html:
					mode === "image"
						? placeholderHtml(label, providerLabel)
						: filePlaceholderHtml(
								label || filenameFromUrl(src),
								providerLabel,
							),
			};
		};

		// Idempotent re-pull: reuse an already-stored object, skip download.
		try {
			if (await store.exists(key)) {
				const url = await store.signedUrl(key);
				reused++;
				return { action: "rewrite", html: rewrite(url) };
			}
		} catch {
			// Treat a metadata lookup error as "not present" and try to fetch.
		}

		try {
			const headers = fetchAuth?.(src) || undefined;
			const fetchUrl = resolveFetchUrl?.(src) || src;
			const res = await fetch(
				fetchUrl,
				headers ? { headers } : undefined,
			);
			if (!res.ok) {
				return placeholder(`http ${res.status} ${res.statusText}`);
			}
			const headerType = (res.headers.get("content-type") || "")
				.split(";")[0]
				.trim()
				.toLowerCase();
			const allowed =
				mode === "image" ? ALLOWED_IMAGE_TYPES : ALLOWED_FILE_TYPES;
			const maxBytes =
				mode === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
			// Read the bytes up front. ADO/Fizzy attachment endpoints frequently
			// return `application/octet-stream` for valid bytes, AND a RE-UPLOADED
			// ADO attachment carries a useless `?fileName=image-0.bin` (the real
			// filename is lost across a push→pull round-trip), so neither the
			// header nor the URL can pin a type. When that happens, the magic
			// bytes are authoritative — hence the sniff below (WI #226/#227/#228).
			const buffer = Buffer.from(await res.arrayBuffer());
			// Empty IMAGES are invalid (a 0-byte image renders as a broken icon),
			// but an empty FILE attachment is legitimate (e.g. an empty .txt) — store
			// it so the download link still works. Reject 0 bytes only for images.
			if (
				(mode === "image" && buffer.length === 0) ||
				buffer.length > maxBytes
			) {
				return placeholder(
					`bad size (${buffer.length} bytes, max ${maxBytes})`,
				);
			}
			let contentType = headerType;
			if (!allowed[contentType]) {
				let inferred: string | null = null;
				if (isGenericBinaryType(headerType)) {
					inferred =
						mode === "image"
							? inferImageContentTypeFromUrl(src)
							: inferFileContentTypeFromUrl(src);
					// Last resort for images: sniff the leading magic bytes.
					if ((!inferred || !allowed[inferred]) && mode === "image") {
						inferred = sniffImageContentType(buffer);
					}
				}
				if (!inferred || !allowed[inferred]) {
					return placeholder(
						`content-type rejected (header="${headerType || "(none)"}", inferred="${inferred ?? "(none)"}")`,
					);
				}
				contentType = inferred;
			}
			await store.put(key, buffer, contentType);
			const url = await store.signedUrl(key);
			ingested++;
			return { action: "rewrite", html: rewrite(url) };
		} catch (err) {
			return placeholder(
				`fetch threw: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	// 1. HTML <img> tags.
	const imgRe = /<img\b[^>]*?>/gi;
	const imgTags = [...description.matchAll(imgRe)].map((m) => m[0]);
	const imgReplacements = await Promise.all(
		imgTags.map(async (tag) => {
			// Already a Fabric story-media image (e.g. merged content) — leave it.
			if (/data-s3-key=["']story-media\//i.test(tag)) {
				skipped++;
				return tag;
			}
			const src = tag.match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? "";
			const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
			const outcome = await handle(src, alt, "image");
			return outcome.action === "keep" ? tag : (outcome.html as string);
		}),
	);
	let imgIndex = 0;
	let out = description.replace(imgRe, () => imgReplacements[imgIndex++]);

	// 2. Markdown ![alt](url) images (defensive — most PM HTML uses <img>).
	const mdRe = /!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
	const mdMatches = [...out.matchAll(mdRe)];
	const mdReplacements = await Promise.all(
		mdMatches.map(async (m) => {
			const alt = m[1] ?? "";
			const src = m[2] ?? "";
			const outcome = await handle(src, alt, "image");
			return outcome.action === "keep" ? m[0] : (outcome.html as string);
		}),
	);
	let mdIndex = 0;
	out = out.replace(mdRe, () => mdReplacements[mdIndex++]);

	// 3. HTML <a href="…">label</a> file links (non-image attachments). Only
	//    URLs matching the provider `urlFilter` are ingested; the Fabric back-
	//    link and arbitrary external links fall through to "keep".
	const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	const anchorMatches = [...out.matchAll(anchorRe)];
	const anchorReplacements = await Promise.all(
		anchorMatches.map(async (m) => {
			const attrs = m[1] ?? "";
			// Already a Fabric story-media link — leave it.
			if (/data-s3-key=["']story-media\//i.test(attrs)) {
				skipped++;
				return m[0];
			}
			const href = attrs.match(/\bhref=["']([^"']*)["']/i)?.[1] ?? "";
			const text = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
			const outcome = await handle(href, text, "file");
			return outcome.action === "keep" ? m[0] : (outcome.html as string);
		}),
	);
	let anchorIndex = 0;
	out = out.replace(anchorRe, () => anchorReplacements[anchorIndex++]);

	// 4. Markdown [label](url) file links — NOT image `![…](…)` (negative
	//    lookbehind on `!`). Same urlFilter gating as anchors.
	const mdLinkRe = /(?<!!)\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
	const mdLinkMatches = [...out.matchAll(mdLinkRe)];
	const mdLinkReplacements = await Promise.all(
		mdLinkMatches.map(async (m) => {
			const text = m[1] ?? "";
			const href = m[2] ?? "";
			const outcome = await handle(href, text, "file");
			return outcome.action === "keep" ? m[0] : (outcome.html as string);
		}),
	);
	let mdLinkIndex = 0;
	out = out.replace(mdLinkRe, () => mdLinkReplacements[mdLinkIndex++]);

	return { description: out, ingested, reused, failed, skipped };
}

// =============================================================================
// Azure DevOps wiring
// =============================================================================

/**
 * ADO attachment URLs are org-scoped on `dev.azure.com`. Both shapes:
 *   inline-image (description):  dev.azure.com/{org}/_apis/wit/attachments/{guid}
 *   relation (AttachedFile):     dev.azure.com/{org}/{projectGuid}/_apis/wit/attachments/{guid}
 *
 * Parsed rather than pattern-matched. The URL comes straight out of an
 * `<img src>` / `<a href>` in a work-item description — third-party text of
 * unbounded length — and this predicate decides whether the ADO PAT is sent
 * to it, so it has to answer "is this host exactly dev.azure.com", which a
 * substring test cannot: `https://other.example/?u=dev.azure.com/_apis/wit/
 * attachments/` satisfied the old regex. Parsing also removes the unbounded
 * `[^\s?#]*` span the engine re-scanned from every candidate start position.
 * Bounded span: js/polynomial-redos
 */
function isAdoAttachmentUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return (
		parsed.protocol === "https:" &&
		parsed.hostname.toLowerCase() === "dev.azure.com" &&
		parsed.pathname.includes("/_apis/wit/attachments/")
	);
}

/** Pull the stable attachment GUID out of an ADO attachment URL. */
export function adoAttachmentId(url: string): string | null {
	return url.match(/_apis\/wit\/attachments\/([0-9a-fA-F-]+)/)?.[1] ?? null;
}

/**
 * Build the ADO-specific ingest options. Downloads are authenticated with the
 * same `Basic base64(":" + PAT)` header the push attachment-upload path uses.
 * The deterministic key id is the ADO attachment GUID so re-pulling the same
 * work item reuses the stored object (no duplication — AC4).
 */
export function buildAdoIngestOptions(
	pat: string,
): Pick<
	IngestPulledImagesParams,
	"fetchAuth" | "urlFilter" | "deriveKeyId" | "providerLabel"
> {
	const auth = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
	return {
		urlFilter: (url) => isAdoAttachmentUrl(url),
		fetchAuth: (url) =>
			isAdoAttachmentUrl(url)
				? {
						Authorization: auth,
						"User-Agent": "Fabric-Sync/1.0 (pm-sync pull)",
						Accept: "image/*,*/*;q=0.8",
					}
				: null,
		deriveKeyId: (url) => adoAttachmentId(url),
		providerLabel: "Azure DevOps",
	};
}

/**
 * Decrypt the ADO PAT from a stored `MCPConfig.encryptedApiKey`. Returns null
 * when absent or undecryptable (caller then leaves the description untouched).
 */
export function resolveAdoPat(
	encryptedApiKey: string | null | undefined,
): string | null {
	if (!encryptedApiKey) {
		return null;
	}
	try {
		const pat = decryptApiKey(encryptedApiKey);
		return pat || null;
	} catch {
		return null;
	}
}

// =============================================================================
// ADO attachment relations (pull)
// =============================================================================

/**
 * Fetch a work item's `AttachedFile` relations from ADO via REST. ADO file
 * attachments live as work-item *relations* (not in the description), so the
 * pull path enumerates them here using the same PAT+org the push attachment-
 * upload uses. `$expand=relations` is requested explicitly. Returns `[]` on any
 * error — pull must still land.
 */
export async function fetchAdoAttachmentRelations(
	workItemId: string | number,
	target: { pat: string; org: string },
): Promise<Array<{ name: string; url: string }>> {
	const auth = `Basic ${Buffer.from(`:${target.pat}`).toString("base64")}`;
	const url = `https://dev.azure.com/${target.org}/_apis/wit/workitems/${workItemId}?$expand=relations&api-version=7.1`;
	try {
		const res = await fetch(url, {
			headers: {
				Authorization: auth,
				Accept: "application/json",
				"User-Agent": "Fabric-Sync/1.0 (pm-sync pull)",
			},
		});
		if (!res.ok) {
			return [];
		}
		const data = (await res.json()) as {
			relations?: Array<{
				rel?: string;
				url?: string;
				attributes?: { name?: string };
			}>;
		};
		const out: Array<{ name: string; url: string }> = [];
		for (const r of data.relations ?? []) {
			if (r.rel === "AttachedFile" && r.url) {
				out.push({
					name: r.attributes?.name || filenameFromUrl(r.url),
					url: r.url,
				});
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Append ADO `AttachedFile` relations to a description as markdown links so the
 * pull ingester downloads + re-hosts them as file attachments. The `?fileName=`
 * query lets `inferFileContentTypeFromUrl` recover the type — ADO attachment
 * URLs carry no extension and serve `application/octet-stream`. Idempotent:
 * skips any attachment whose URL is already referenced in the description.
 */
/** Matches the canonical back-link anchor once it has been localized to a small window. */
const BACK_LINK_RE =
	/(?:<p[^>]*>\s*)?(?:<a\b[^>]*>\s*View in Fabric\s*<\/a>|\[View in Fabric\]\([^)]*\))/i;

/** Fixed label text the back-link anchor is always built around (see `fabric-url.ts`). */
const BACK_LINK_LABEL = "View in Fabric";

/**
 * Locate the canonical "View in Fabric" back-link anchor's absolute start
 * index in `description`, or null when none is present.
 *
 * Bounded span: js/polynomial-redos — rather than run `BACK_LINK_RE` (which
 * can backtrack) over the whole description, first find an occurrence of its
 * fixed label text with a linear `lastIndexOf`. Then run the regex only on a
 * small window around that occurrence: a few hundred chars before it (enough
 * for the `<p ...><a ...>` / `[` prefix) through just past the label (enough
 * for `</a></p>` or the markdown `)`). Worst-case regex work per occurrence is
 * therefore a small constant, independent of how long the description is.
 *
 * `appendFabricBackLink` (`packages/database/prisma/queries/projects/
 * fabric-url.ts`) is idempotent — it never inserts a second back-link — so
 * the anchor itself occurs at most once. But the label is plain text
 * ("View in Fabric"), and nothing stops it from also appearing in a user's
 * own prose elsewhere in the description — most likely AFTER the real
 * back-link, since that's where new edits land. `lastIndexOf` alone would
 * find that later, non-anchor occurrence and fail its window check, making
 * the whole lookup miss the real (earlier) back-link entirely. So on a
 * window miss, walk backward to the label's next-earlier occurrence and
 * retry, until one validates or there are none left. Still linear: each
 * occurrence is visited once and each window check is the same small
 * constant as before, so total work is bounded by the number of label
 * occurrences, not by re-scanning the description.
 */
function findBackLinkIndex(description: string): number | null {
	let fromIndex = description.length - 1;
	for (;;) {
		const labelIndex = description.lastIndexOf(BACK_LINK_LABEL, fromIndex);
		if (labelIndex === -1) {
			return null;
		}
		const windowStart = Math.max(0, labelIndex - 300);
		const windowEnd = Math.min(
			description.length,
			labelIndex + BACK_LINK_LABEL.length + 50,
		);
		const window = description.slice(windowStart, windowEnd);
		const match = BACK_LINK_RE.exec(window);
		if (match) {
			return windowStart + match.index;
		}
		fromIndex = labelIndex - 1;
	}
}

export function appendAdoAttachmentLinks(
	description: string,
	attachments: ReadonlyArray<{ name: string; url: string }>,
): string {
	const fresh = attachments.filter((a) => !description.includes(a.url));
	if (fresh.length === 0) {
		return description;
	}
	const links = fresh
		.map((a) => {
			const sep = a.url.includes("?") ? "&" : "?";
			const tagged = `${a.url}${sep}fileName=${encodeURIComponent(a.name)}`;
			return `[${a.name}](${tagged})`;
		})
		.join("\n");
	// Insert the attachment link(s) just BEFORE the "View in Fabric" back-link
	// when present, so they sit with the body rather than after the footer.
	// No heading — a markdown `## Attachments` would render as literal text in
	// an ADO (HTML) description. Falls back to appending at the end.
	const backLinkIndex = findBackLinkIndex(description);
	if (backLinkIndex !== null) {
		const head = description.slice(0, backLinkIndex).trimEnd();
		const tail = description.slice(backLinkIndex);
		return `${head}\n\n${links}\n\n${tail}`;
	}
	return `${description.trimEnd()}\n\n${links}`;
}

// =============================================================================
// Fizzy wiring
// =============================================================================

/** Fizzy serves attachments from Rails ActiveStorage (blobs + representations). */
const FIZZY_ATTACHMENT_RE =
	/\/rails\/active_storage\/(?:blobs|representations)\/redirect\//i;

/** Fizzy's web origin — account-relative ActiveStorage URLs resolve against it. */
const FIZZY_BASE_URL = "https://app.fizzy.do";

/** Hostname `isFizzyAttachmentUrl` pins absolute URLs to. */
const FIZZY_BASE_HOSTNAME = new URL(FIZZY_BASE_URL).hostname;

/**
 * `FIZZY_ATTACHMENT_RE` is path-only, with no host component — an `<img
 * src="https://attacker.example/rails/active_storage/blobs/redirect/x/y.png">`
 * in a card body satisfied it just as well as a real Fizzy URL, and since
 * `resolveFetchUrl` returned any absolute `http(s)://` URL unchanged, that
 * would send the Fizzy Bearer API key straight to `attacker.example`. This
 * predicate is what `urlFilter`, `fetchAuth` and `resolveFetchUrl` gate on
 * instead: an absolute URL only qualifies when it parses, is `https:`, and
 * its hostname equals `FIZZY_BASE_URL`'s own; a relative path keeps the
 * existing slug-insertion behavior and is always in-scope (mirrors the
 * `dev.azure.com` host pin in `isAdoAttachmentUrl`).
 */
function isFizzyAttachmentUrl(url: string): boolean {
	if (/^https?:\/\//i.test(url)) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		return (
			parsed.protocol === "https:" &&
			parsed.hostname.toLowerCase() === FIZZY_BASE_HOSTNAME &&
			FIZZY_ATTACHMENT_RE.test(parsed.pathname)
		);
	}
	return FIZZY_ATTACHMENT_RE.test(url);
}

/** Pull the Rails signed blob id out of a Fizzy ActiveStorage redirect URL. */
export function fizzyBlobId(url: string): string | null {
	return (
		url.match(/\/(?:blobs|representations)\/redirect\/([^/]+)\//)?.[1] ??
		null
	);
}

/**
 * Build the Fizzy-specific ingest options. Fizzy embeds media as Rails
 * ActiveStorage redirect URLs, usually account-relative
 * (`/{accountSlug}/rails/active_storage/blobs/redirect/{signedId}/{file}`).
 * Downloads use the same Bearer API key the push attachment path uses
 * (`decryptApiKey(mcpConfig.encryptedApiKey)`); relative URLs are resolved
 * against `app.fizzy.do`. The deterministic key id is the Rails signed blob id
 * so re-pulling the same card reuses the stored object instead of duplicating
 * it. `accountSlug` is accepted for API parity / future scoping.
 */
export function buildFizzyIngestOptions(
	apiKey: string,
	accountSlug: string,
): Pick<
	IngestPulledImagesParams,
	| "fetchAuth"
	| "urlFilter"
	| "deriveKeyId"
	| "resolveFetchUrl"
	| "providerLabel"
> {
	const auth = `Bearer ${apiKey}`;
	const slug = accountSlug.replace(/^\/+|\/+$/g, "");
	return {
		urlFilter: (url) => isFizzyAttachmentUrl(url),
		fetchAuth: (url) =>
			isFizzyAttachmentUrl(url)
				? {
						Authorization: auth,
						"User-Agent": "Fabric-Sync/1.0 (pm-sync pull)",
						Accept: "image/*,*/*;q=0.8",
					}
				: null,
		resolveFetchUrl: (url) => {
			if (/^https?:\/\//i.test(url)) {
				// Already gated by isFizzyAttachmentUrl above (via urlFilter) — a
				// qualifying absolute URL is already same-host and needs no rewrite.
				// A non-qualifying one is inert here too: fetchAuth returns null for
				// it, so it is fetched with no credentials, if it is ever reached at
				// all — urlFilter stops `handle()` before resolveFetchUrl runs.
				return url;
			}
			let path = url.startsWith("/") ? url : `/${url}`;
			// Fizzy FILE attachments expose a slug-LESS wrapper url
			// (`/rails/active_storage/blobs/redirect/{sgid}/file`); the download
			// 404s without the account slug, so insert it. Image nodes already
			// carry the slug (`/{slug}/rails/…`) and are left untouched.
			if (slug && /^\/rails\/active_storage\//i.test(path)) {
				path = `/${slug}${path}`;
			}
			return `${FIZZY_BASE_URL}${path}`;
		},
		deriveKeyId: (url) => fizzyBlobId(url),
		providerLabel: "Fizzy",
	};
}

/**
 * Decrypt the Fizzy API key from a stored `MCPConfig.encryptedApiKey`. Returns
 * null when absent or undecryptable (caller then leaves the description
 * untouched). Mirror of `resolveAdoPat` for the api-package import path.
 */
export function resolveFizzyApiKey(
	encryptedApiKey: string | null | undefined,
): string | null {
	if (!encryptedApiKey) {
		return null;
	}
	try {
		const key = decryptApiKey(encryptedApiKey);
		return key || null;
	} catch {
		return null;
	}
}

// =============================================================================
// GitLab wiring
// =============================================================================

/** GitLab uploads are referenced by `/uploads/{32-hex secret}/{filename}`. */
const GITLAB_UPLOAD_RE = /\/uploads\/[0-9a-f]{32}\//i;

/** Pull the 32-hex upload secret out of a GitLab `/uploads/` URL. */
export function gitlabUploadId(url: string): string | null {
	return url.match(/\/uploads\/([0-9a-f]{32})\//i)?.[1] ?? null;
}

/**
 * Strip GitLab Flavored Markdown image-attribute blocks — `![alt](url){width=W
 * height=H}` (also `{width=50%}`, `{align=center}`, …). GitLab renders the
 * trailing `{…}` as a sizing directive, but Fabric's markdown-it does not, so
 * on pull it shows up as literal `{width=301 height=167}` text next to the
 * image (GitLab issue #9). Only a `{…}` attached directly to a markdown image
 * `)` or an `<img>` `>` is removed — standalone `{…}` in prose is untouched.
 */
export function stripGitLabImageAttributes(description: string): string {
	if (!description) {
		return description;
	}
	// Bounded span: js/polynomial-redos — only the leading span runs through
	// the regex below; content beyond it is passed through untouched.
	const { head, tail } = boundedRegexSpan(description);
	return (
		head.replace(/(!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>)\{[^}]*\}/gi, "$1") +
		tail
	);
}

/**
 * Build the GitLab-specific ingest options. GitLab embeds uploads as
 * project-relative `/uploads/{secret}/{filename}` links in the markdown
 * description. Downloads use the integration's OAuth Bearer token against the
 * REST endpoint `GET /api/v4/projects/:id/uploads/:secret/:filename` (GitLab
 * 17.4+) — NOT the `/-/project/…` web route, which requires a session cookie.
 * The deterministic key id is the 32-hex upload secret so re-pulling the same
 * issue reuses the stored object.
 */
export function buildGitLabIngestOptions(
	token: string,
	projectId: string,
	baseUrl = "https://gitlab.com",
): Pick<
	IngestPulledImagesParams,
	| "fetchAuth"
	| "urlFilter"
	| "deriveKeyId"
	| "resolveFetchUrl"
	| "providerLabel"
> {
	const root = baseUrl.replace(/\/+$/, "");
	const apiBase = root.endsWith("/api/v4") ? root : `${root}/api/v4`;
	return {
		urlFilter: (url) => GITLAB_UPLOAD_RE.test(url),
		fetchAuth: (url) =>
			GITLAB_UPLOAD_RE.test(url)
				? {
						Authorization: `Bearer ${token}`,
						"User-Agent": "Fabric-Sync/1.0 (pm-sync pull)",
						Accept: "image/*,*/*;q=0.8",
					}
				: null,
		// GitLab uploads in markdown are `/uploads/{secret}/{filename}` (project-
		// relative). The download endpoint that accepts the OAuth token is the
		// REST API `GET /projects/:id/uploads/:secret/:filename` (GitLab 17.4+) —
		// NOT the `/-/project/...` web route, which needs a session cookie. Build
		// the API URL from the secret + filename regardless of the input shape.
		resolveFetchUrl: (url) => {
			const m = url.match(/\/uploads\/([0-9a-f]{32})\/([^?#]+)/i);
			if (!m) {
				return url;
			}
			const [, secret, filename] = m;
			return `${apiBase}/projects/${encodeURIComponent(
				projectId,
			)}/uploads/${secret}/${filename}`;
		},
		deriveKeyId: (url) => gitlabUploadId(url),
		providerLabel: "GitLab",
	};
}
