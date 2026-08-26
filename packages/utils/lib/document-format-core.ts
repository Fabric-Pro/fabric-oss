/**
 * The document formats that can be uploaded as AI context, and the projections
 * every upload surface derives from them.
 *
 * Four upload surfaces used to keep four hand-maintained format lists, and they
 * did not stay in agreement: JSON was attachable in chat but not uploadable as
 * project context, workspace documents accepted five formats where project
 * context accepted thirteen, and XML was refused everywhere despite the text
 * extractor having claimed `application/xml` all along. This module is the one
 * list the non-chat surfaces build from.
 *
 * It is a *core*, not a merged vocabulary. Surfaces stay deliberately different —
 * project context accepts screenshots and Excalidraw scenes, workspace documents
 * is a document library and takes none of that — so each composes this core with
 * its own named extras rather than sharing one allowlist. See CONCEPTS.md
 * ("Format vocabulary": vocabularies are per-surface by design but compose from
 * one shared resolver) and
 * docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md.
 *
 * Admission rule: every MIME here is claimed by a registered extractor. A format
 * admitted without one trades today's clean refusal for a file that stores and
 * then dies downstream — the reason `application/xhtml+xml` is refused in
 * attachment.ts. Fizzy #2149.
 *
 * **Package-private by design.** This module has no subpath export in
 * `package.json` and is not re-exported from the barrel: the two surface
 * vocabularies are the public API, and a consumer reaching past them to compose
 * its own set is the drift this core exists to end. Add a subpath export only if
 * a genuine third consumer appears — the omission is a decision, not an oversight.
 */

import { extensionOf, resolveAttachmentMime } from "./attachment";
import type { UploadCategory } from "./upload-size-limits";

export type DocumentFormatEntry = {
	/** Size bucket and persisted context type. Not merely a size knob: `text/plain` is FILE while `application/pdf` is DOCUMENT at the same limit. */
	type: UploadCategory;
	/** The one extension a file of this type is stored as. */
	extension: string;
	/** Every extension that resolves to this MIME, canonical first. Omitted when the canonical extension is the only one. */
	acceptExtensions?: readonly string[];
	/**
	 * Resolve this format from its extension ahead of whatever the browser
	 * declared. Set where the declared value is routinely wrong or absent:
	 * browsers report `.xml` as `text/xml` rather than the allowlisted
	 * `application/xml`, and report `.yaml`/`.yml` as nothing at all. Forcing
	 * both rescues an untyped file and canonicalizes an alias spelling in one
	 * step, which is what keeps a single MIME per format true downstream.
	 */
	forceByExtension?: boolean;
};

/**
 * The shared core. Ordered documents first, then plain-text formats, then
 * spreadsheets, then the structured-text formats this ticket admits.
 *
 * `application/msword` is claimed by `LocalDocxExtractor` and so passes the
 * coverage guard, but mammoth reads OOXML rather than the legacy binary format,
 * so a `.doc` still fails at runtime. It is the standing example of what MIME
 * membership cannot prove. See `workspace-document-upload.ts` for why it stays.
 */
export const DOCUMENT_FORMAT_CORE: Readonly<
	Record<string, DocumentFormatEntry>
> = Object.freeze({
	"application/pdf": { type: "DOCUMENT", extension: "pdf" },
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
		type: "DOCUMENT",
		extension: "docx",
	},
	"application/msword": { type: "DOCUMENT", extension: "doc" },
	"text/plain": { type: "FILE", extension: "txt" },
	"text/markdown": { type: "FILE", extension: "md" },
	// One MIME, three extensions. Browsers report `.xhtml` as
	// `application/xhtml+xml` — deliberately not allowlisted, because no
	// extractor claims it — so the extension has to win. #1684.
	"text/html": {
		type: "FILE",
		extension: "html",
		acceptExtensions: ["html", "htm", "xhtml"],
		forceByExtension: true,
	},
	"text/csv": { type: "SPREADSHEET", extension: "csv" },
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
		type: "SPREADSHEET",
		extension: "xlsx",
	},
	// Already extractable by LocalTextExtractor before this change; simply never
	// offered by the non-chat pickers. Forced because an untyped `.json` would
	// otherwise fall through to the shared extension map, which carries no
	// `json` key — and adding one there would advertise `.json` on the
	// story-attachment picker, whose gate refuses it.
	"application/json": {
		type: "FILE",
		extension: "json",
		forceByExtension: true,
	},
	// Likewise already claimed by LocalTextExtractor. Extracted with markup
	// intact rather than stripped: XML element names and attribute values carry
	// the meaning, unlike HTML markup, which is presentation.
	"application/xml": {
		type: "FILE",
		extension: "xml",
		forceByExtension: true,
	},
	// `application/yaml` is the type RFC 9512 registers; `text/yaml` and
	// `application/x-yaml` canonicalize onto it by extension. Registered with
	// LocalTextExtractor in the same change that admits it here.
	"application/yaml": {
		type: "FILE",
		extension: "yaml",
		acceptExtensions: ["yaml", "yml"],
		forceByExtension: true,
	},
});

/** Every extension a format is advertised under, canonical first. */
function extensionsFor(entry: DocumentFormatEntry): readonly string[] {
	return entry.acceptExtensions ?? [entry.extension];
}

/** Allowlist form, for the resolvers that take one. */
export function formatAllowlist(
	entries: Record<string, DocumentFormatEntry>,
): readonly string[] {
	return Object.keys(entries);
}

/**
 * `accept` attribute: dotted extensions, never MIME strings. An extension-based
 * accept is what lets an OS with no registration for `.md` still offer
 * `design.md` for selection. #2139.
 */
export function formatAcceptAttr(
	entries: Record<string, DocumentFormatEntry>,
): string {
	return Array.from(new Set(Object.values(entries).flatMap(extensionsFor)))
		.map((extension) => `.${extension}`)
		.join(",");
}

/**
 * Uppercase names for user-facing "supported formats" copy. Canonical extension
 * only — spelling every alias out in a refusal message adds noise, not clarity.
 */
export function formatLabels(
	entries: Record<string, DocumentFormatEntry>,
): readonly string[] {
	return Array.from(
		new Set(
			Object.values(entries).map((entry) =>
				entry.extension.toUpperCase(),
			),
		),
	);
}

/**
 * Extension -> canonical MIME for the formats whose declared type cannot be
 * trusted. Derived rather than hand-written: this is the list most likely to
 * drift, because a format added to the core later reaches every accept
 * attribute automatically and would reach no forced map at all.
 */
export function forcedExtensionMap(
	entries: Record<string, DocumentFormatEntry>,
): Record<string, string> {
	const forced: Record<string, string> = {};
	for (const [mimeType, entry] of Object.entries(entries)) {
		if (!entry.forceByExtension) {
			continue;
		}
		for (const extension of extensionsFor(entry)) {
			forced[extension] = mimeType;
		}
	}
	return forced;
}

/** MIME -> canonical extension, for surfaces that store the pair in that shape. */
export function formatExtensionMap(
	entries: Record<string, DocumentFormatEntry>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(entries).map(([mimeType, entry]) => [
			mimeType,
			entry.extension,
		]),
	);
}

/**
 * The vocabulary entry for a resolved MIME, or undefined when the surface does
 * not admit it. **This is the gate**, not `resolveFormatMime` below — that one
 * returns the caller's own value when nothing resolves, so a client testing its
 * result for null would admit everything.
 *
 * Own-property lookup is the point. A plain-object index returns a truthy
 * inherited member for keys like `constructor` or `toString`, so a caller
 * declaring `mimeType: "constructor"` would pass a `if (!config)` check and then
 * read `undefined` for `type` and `extension` — sizing an upload against an
 * undefined limit, which every comparison passes.
 */
export function configFor(
	entries: Record<string, DocumentFormatEntry>,
	mimeType: string,
): DocumentFormatEntry | undefined {
	return Object.hasOwn(entries, mimeType) ? entries[mimeType] : undefined;
}

/**
 * Resolve a file's effective MIME for one surface: forced extensions first,
 * then an allowlisted declared type, then the shared extension fallback.
 *
 * The forced step wins outright because it exists for the formats whose declared
 * type cannot be trusted — believing it would route HTML bytes to the PDF reader
 * or drop an `.svg` into the XML entry. It also does double duty as the rescue
 * for a file the OS gave no type at all, and as the canonicalizer that collapses
 * alias spellings onto one MIME per format.
 *
 * Returns the caller's original MIME when nothing resolves, so the caller can
 * quote what the browser actually claimed in its refusal message. Callers that
 * need to refuse pair this with `configFor`.
 */
export function resolveFormatMime(
	filename: string,
	mimeType: string,
	forced: Record<string, string>,
	allowlist: readonly string[],
): string {
	const ext = extensionOf(filename);
	// Own-property lookup, for the same reason `configFor` uses one: a file
	// named `x.constructor` would otherwise "resolve" to a function.
	if (ext && Object.hasOwn(forced, ext)) {
		return forced[ext];
	}
	return resolveAttachmentMime(filename, mimeType, allowlist) ?? mimeType;
}
