/**
 * User-facing copy for the project-context upload surfaces, derived.
 *
 * Every format the user is told about — in the dropzone helper text and in a
 * refusal message — comes from the shared vocabulary in `@repo/utils`, never
 * from a list typed out in a component. A hand-kept copy is how the dropzone
 * came to advertise six formats while the server accepted sixteen.
 * See docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md.
 *
 * This lives in `lib/` rather than inside one component because two surfaces
 * render it — `ContextUploaderDialog` (post-creation + wizard-embedded) and
 * `WizardFileUploader` (project-creation wizard). Two derivations of the same
 * sentence is the same drift one derivation exists to prevent, so the surfaces
 * import this pair rather than each computing their own.
 */

import {
	CONTEXT_UPLOAD_FORMAT_LABELS,
	CONTEXT_UPLOAD_MIME_TYPES,
	formatSizeLimit,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";

/** "PDF, DOCX, DOC, …" — the canonical labels, for refusal messages. */
const CONTEXT_UPLOAD_SUPPORTED_FORMATS: string =
	CONTEXT_UPLOAD_FORMAT_LABELS.join(", ");

/** Canonical label → the byte limit its category carries. */
const CONTEXT_UPLOAD_LIMIT_BY_LABEL: ReadonlyMap<string, number> = new Map(
	Object.values(CONTEXT_UPLOAD_MIME_TYPES).map((entry) => [
		entry.extension.toUpperCase(),
		UPLOAD_SIZE_LIMITS[entry.type],
	]),
);

/**
 * Dropzone helper copy: the labels grouped by the limit they share, largest
 * first — "PDF, … — 20MB maximum · CSV, … — 10MB maximum". Both halves are
 * derived, so a format admitted later is advertised at its real limit without
 * anyone remembering to edit this string.
 */
export const CONTEXT_UPLOAD_FORMATS_AND_LIMITS: string = (() => {
	const byLimit = new Map<number, string[]>();
	for (const label of CONTEXT_UPLOAD_FORMAT_LABELS) {
		const limit = CONTEXT_UPLOAD_LIMIT_BY_LABEL.get(label);
		if (limit === undefined) {
			continue;
		}
		const bucket = byLimit.get(limit);
		if (bucket) {
			bucket.push(label);
		} else {
			byLimit.set(limit, [label]);
		}
	}
	return Array.from(byLimit.entries())
		.sort(([a], [b]) => b - a)
		.map(
			([limit, labels]) =>
				`${labels.join(", ")} — ${formatSizeLimit(limit)}`,
		)
		.join(" · ");
})();

/**
 * Refusal copy for a type this surface does not admit. Names all three things
 * a refusal has to name: which file, what it was refused as, and what would
 * have been accepted.
 */
export function unsupportedTypeReason(
	filename: string,
	refusedType: string,
): string {
	return `${filename} is not a supported file type (${refusedType}). Supported formats: ${CONTEXT_UPLOAD_SUPPORTED_FORMATS}.`;
}

/**
 * Refusal copy for an admitted type that exceeds its category's limit. Kept
 * beside the type refusal so both surfaces word an oversize file the same way.
 */
export function oversizeReason(filename: string, maxBytes: number): string {
	return `${filename} is too large. ${formatSizeLimit(maxBytes)}.`;
}
