/**
 * Shared file-type vocabulary for the Project Context and wizard-temp upload
 * surfaces. Both procedures used to carry byte-identical copies of this map +
 * resolver; consolidated here so the .excalidraw normalization is unit-tested
 * once. Kept separate from the story-attachment allowlist (attachment.ts),
 * which is a different surface with its own limits. #1942.
 *
 * The document formats now come from `document-format-core.ts`, which the
 * workspace-document surface builds from as well. What stays here is what makes
 * this surface different: it takes screenshots for OCR and Excalidraw scenes,
 * and workspace documents takes neither. Fizzy #2149.
 */

import { EXCALIDRAW_MIME } from "./attachment";
import {
	configFor,
	DOCUMENT_FORMAT_CORE,
	type DocumentFormatEntry,
	forcedExtensionMap,
	formatAcceptAttr,
	formatAllowlist,
	formatLabels,
	resolveFormatMime,
} from "./document-format-core";
import type { UploadCategory } from "./upload-size-limits";

/**
 * What this surface admits on top of the shared document core.
 *
 * `image/svg+xml` is typed FILE rather than IMAGE, and is deliberately not an
 * OCR/vision input — `LocalTextExtractor` claims it and reads it as text, which
 * is what SVG's markup warrants. It is forced by extension because the core
 * admits `application/xml`: without forcing, an `.svg` whose declared type is
 * `application/xml` would resolve to XML, since a recognised declared type beats
 * the extension. Forcing is what keeps `.svg` resolving to itself.
 */
const CONTEXT_UPLOAD_ONLY_FORMATS: Record<string, DocumentFormatEntry> = {
	// Images (for OCR)
	"image/jpeg": {
		type: "IMAGE",
		extension: "jpg",
		acceptExtensions: ["jpg", "jpeg"],
	},
	"image/png": { type: "IMAGE", extension: "png" },
	"image/webp": { type: "IMAGE", extension: "webp" },
	"image/svg+xml": {
		type: "FILE",
		extension: "svg",
		forceByExtension: true,
	},
	// Excalidraw diagrams (JSON). Custom vendor MIME; typed FILE so it inherits
	// the 20 MB limit and the free Class-A download. #1942.
	[EXCALIDRAW_MIME]: {
		type: "FILE",
		extension: "excalidraw",
		forceByExtension: true,
	},
};

export const CONTEXT_UPLOAD_MIME_TYPES: Record<string, DocumentFormatEntry> = {
	...DOCUMENT_FORMAT_CORE,
	...CONTEXT_UPLOAD_ONLY_FORMATS,
};

/**
 * Extensions whose canonical MIME is forced ahead of whatever the browser
 * declared, because the declared value is routinely wrong for them and
 * believing it routes the file to the wrong extractor — HTML bytes to the PDF
 * reader, an Excalidraw document to the plain-text reader. Browsers report
 * `.xhtml` as `application/xhtml+xml` (deliberately not allowlisted) and often
 * report the `.htm`/`.html` pair as "" from a drag-and-drop. #1684, #1942.
 *
 * Derived from the vocabulary rather than written out: a format added later
 * reaches the accept attribute automatically, and would otherwise reach no
 * forced map at all.
 */
const FORCED_EXTENSION_MIME: Record<string, string> = forcedExtensionMap(
	CONTEXT_UPLOAD_MIME_TYPES,
);

/** Allowlist form of the map above, hoisted so batch uploads do not rebuild it per file. */
const CONTEXT_UPLOAD_MIME_ALLOWLIST: readonly string[] = formatAllowlist(
	CONTEXT_UPLOAD_MIME_TYPES,
);

/**
 * Resolve the effective MIME for a context upload from the browser-reported
 * MIME and the filename.
 *
 * Two steps. The forced map above wins outright, for the extensions whose
 * declared type cannot be trusted. Everything else defers to the shared
 * `resolveAttachmentMime`, composed with this surface's own allowlist: an
 * allowlisted declared MIME is used as-is, and anything else falls back to the
 * filename extension. That fallback is the fix for #2139 — `File.type` is empty
 * whenever the OS has no registration for the extension, and the client sends
 * `application/octet-stream` in its place, which is not a type this surface
 * knows. Twelve of the sixteen advertised extensions were refused that way.
 *
 * Returns the caller's original MIME when nothing resolves, so the caller — which
 * rejects by looking the result up in `CONTEXT_UPLOAD_MIME_TYPES` — can quote
 * what the browser actually claimed in its error message.
 */
export function resolveContextUploadMime(
	mimeType: string,
	filename: string,
): string {
	// Argument order is this surface's own and predates the shared resolver;
	// kept so call sites do not have to move. See the convention doc: change the
	// vocabulary, not the call sites.
	return resolveFormatMime(
		filename,
		mimeType,
		FORCED_EXTENSION_MIME,
		CONTEXT_UPLOAD_MIME_ALLOWLIST,
	);
}

/**
 * Resolve a context upload's MIME and the size category that follows from it.
 *
 * Both pickers need the pair, and deriving the category from the *resolved*
 * type rather than the browser's is what keeps the pre-upload size check
 * truthful: an untyped file categorized from the `application/octet-stream`
 * placeholder falls through to the 20 MB FILE limit, so an oversize image would
 * clear the picker and then be refused server-side after the upload had run.
 *
 * Categories come from this surface's own map rather than `resolveUploadCategory`,
 * which disagrees with it for `image/svg+xml` (IMAGE versus FILE). The server
 * sizes against this map, so the client has to as well.
 */
export function resolveContextUploadCategory(
	mimeType: string,
	filename: string,
): { resolvedMimeType: string; category: UploadCategory } {
	const resolvedMimeType = resolveContextUploadMime(mimeType, filename);
	return {
		resolvedMimeType,
		category: contextUploadConfigFor(resolvedMimeType)?.type ?? "FILE",
	};
}

/**
 * Allowlist entry for a resolved MIME, or undefined when it is not allowlisted.
 *
 * Own-property lookup is the point. A plain-object index returns a truthy
 * inherited member for keys like `constructor` or `toString`, so a caller
 * declaring `mimeType: "constructor"` would pass a `if (!config)` type gate and
 * then read `undefined` for `type` and `extension` — sizing the upload against
 * an undefined limit, which every comparison passes. Callers must gate through
 * this rather than indexing the map directly.
 */
export function contextUploadConfigFor(
	mimeType: string,
): DocumentFormatEntry | undefined {
	return configFor(CONTEXT_UPLOAD_MIME_TYPES, mimeType);
}

/**
 * `accept` attribute for every context-upload picker, derived from the
 * allowlist above so the picker cannot advertise a type the server rejects —
 * or omit one it accepts. Hand-kept copies of this string previously lived in
 * two components and drifted. See
 * docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md.
 *
 * Alias extensions (`.jpeg` for `image/jpeg`, `.htm`/`.xhtml` for `text/html`,
 * `.yml` for `application/yaml`) come from each entry's own `acceptExtensions`,
 * so the picker and the resolver read one list rather than two.
 */
export const CONTEXT_UPLOAD_ACCEPT_ATTR: string = formatAcceptAttr(
	CONTEXT_UPLOAD_MIME_TYPES,
);

/**
 * Uppercase format names for user-facing "supported types" copy. Derived from
 * the canonical extension only — the picker advertises `.jpeg` and `.xhtml`,
 * but spelling every alias out in an error message adds noise, not clarity.
 */
export const CONTEXT_UPLOAD_FORMAT_LABELS: readonly string[] = formatLabels(
	CONTEXT_UPLOAD_MIME_TYPES,
);
