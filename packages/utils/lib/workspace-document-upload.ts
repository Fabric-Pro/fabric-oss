/**
 * Shared file-type vocabulary for the workspace-document upload surface.
 *
 * This list used to live as a module-level literal inside `DocumentUploader`,
 * where the picker's `accept` attribute was built from MIME strings alone. That
 * is what greys `.md` out of the OS file dialog on a machine with no `.md`
 * registration — the dialog matches the advertised MIME against the OS
 * registry, finds nothing, and disables the file. Deriving `accept` from
 * extensions instead makes the dialog offer every format the allowlist carries.
 *
 * The set is now exactly the shared document core: this surface is a document
 * library, so it takes the core and none of the extras the project-context
 * surface adds (screenshots for OCR, Excalidraw scenes). It previously carried
 * five formats where project context carried thirteen, and CSV, XLSX, HTML,
 * JSON, XML and YAML were all extractable long before this picker offered them.
 * Fizzy #2149.
 *
 * See docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md
 * — both the `accept` attribute and every validation gate behind it derive from
 * this one map. Fizzy #2139.
 */

import {
	configFor,
	DOCUMENT_FORMAT_CORE,
	type DocumentFormatEntry,
	forcedExtensionMap,
	formatAcceptAttr,
	formatAllowlist,
	formatExtensionMap,
	formatLabels,
	resolveFormatMime,
} from "./document-format-core";

/**
 * This surface's vocabulary: the shared core, unmodified.
 *
 * `application/msword` rides along from the core and is the one entry that is
 * accepted but not extractable in practice: `LocalDocxExtractor` claims the MIME,
 * so it passes the coverage guard, but mammoth reads OOXML rather than the
 * legacy binary `.doc` format, so such a file uploads and then fails extraction.
 * Removing it would drop a format this surface accepts today, so it stays until
 * a legacy extractor lands or the removal is taken deliberately.
 */
const WORKSPACE_DOCUMENT_FORMATS: Record<string, DocumentFormatEntry> =
	DOCUMENT_FORMAT_CORE;

/**
 * Canonical MIME -> canonical extension for the workspace document picker.
 * Projected from the vocabulary above; callers that need alias extensions read
 * the accept attribute rather than this map.
 */
export const WORKSPACE_DOCUMENT_MIME_TYPES: Record<string, string> =
	formatExtensionMap(WORKSPACE_DOCUMENT_FORMATS);

/**
 * Allowlist passed to `resolveAttachmentMime` by both the picker (advisory) and
 * the two server persistence points (normalization). Derived from the map above
 * so a format cannot be advertised without being resolvable.
 */
export const WORKSPACE_DOCUMENT_MIME_ALLOWLIST: readonly string[] =
	formatAllowlist(WORKSPACE_DOCUMENT_FORMATS);

/**
 * Extensions whose canonical MIME is forced ahead of the declared value. This
 * surface had no forced layer at all, which is why an untyped `.yml` or a
 * `text/xml`-typed `.xml` would have been advertised by the picker and then
 * refused by it. Derived from the vocabulary, so the forced map cannot fall
 * behind the accept attribute.
 */
const FORCED_EXTENSION_MIME: Record<string, string> = forcedExtensionMap(
	WORKSPACE_DOCUMENT_FORMATS,
);

/**
 * `accept` attribute for the workspace document picker: dotted extensions, not
 * MIME strings. An extension-based `accept` is what lets an OS with no
 * registration for `.md` still offer `design.md` for selection.
 *
 * Built from each entry's own extension list rather than the projected map
 * above, so alias extensions (`.htm`, `.xhtml`, `.yml`) are offered. Deriving it
 * from `Object.values` of the MIME->extension map would have silently dropped
 * them while every label assertion still passed.
 */
export const WORKSPACE_DOCUMENT_ACCEPT_ATTR: string = formatAcceptAttr(
	WORKSPACE_DOCUMENT_FORMATS,
);

/**
 * Uppercase format names for the dialog's "supported formats" copy. Sourced
 * from the same map so the copy cannot understate the allowlist — it named four
 * formats while five were accepted, leaving `.doc` accepted but unadvertised.
 */
export const WORKSPACE_DOCUMENT_FORMAT_LABELS: readonly string[] = formatLabels(
	WORKSPACE_DOCUMENT_FORMATS,
);

/**
 * Resolve a workspace document's MIME, falling back to the filename extension
 * when the browser declared nothing this surface recognises.
 *
 * Returns the caller's value rather than null when nothing resolves: this
 * surface has never gated on file type, and turning normalization into a gate
 * would refuse uploads that succeed today. The picker still refuses what it
 * cannot resolve; the server only normalizes.
 *
 * Because this function cannot refuse, a client that needs a gate pairs it with
 * `workspaceDocumentConfigFor` rather than testing its result for null.
 */
export function resolveWorkspaceDocumentMime(
	filename: string,
	mimeType: string,
): string {
	return resolveFormatMime(
		filename,
		mimeType,
		FORCED_EXTENSION_MIME,
		WORKSPACE_DOCUMENT_MIME_ALLOWLIST,
	);
}

/**
 * Allowlist entry for a resolved MIME, or undefined when it is not allowlisted.
 *
 * The picker's fail-closed gate. `resolveWorkspaceDocumentMime` deliberately
 * cannot refuse — it returns the caller's value when nothing resolves — so a
 * client testing that result for null would accept everything. Mirrors
 * `contextUploadConfigFor`, including its own-property lookup: a plain-object
 * index returns a truthy inherited member for keys like `constructor`, which
 * would pass a `if (!config)` gate and then read `undefined` for `extension`.
 */
export function workspaceDocumentConfigFor(
	mimeType: string,
): DocumentFormatEntry | undefined {
	return configFor(WORKSPACE_DOCUMENT_FORMATS, mimeType);
}
