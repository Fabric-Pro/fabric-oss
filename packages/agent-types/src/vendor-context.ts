/**
 * Vendor-context marker (company context, Fizzy #2719).
 *
 * Proposal and Business Case generation retrieve the organization's company
 * context — material the organization keeps about itself — and append it to
 * the project's retrieved context. The contexts travel as plain strings all
 * the way to the prompt, so the only label that survives every hop is one
 * inside the string. Each company entry therefore starts with this marker,
 * written by the retrieval activity and read by every place that decides
 * something from the context list:
 *
 * - "Does the project have context of its own?" counts only unmarked entries.
 *   Wizard features drop out of the prompt when retrieved context exists; a
 *   project with no context of its own must keep them, whatever the company
 *   context holds.
 * - The default Proposal template permits one vendor-qualifications section
 *   only when marked entries are present.
 *
 * Kept here, not in a Temporal or prompt package, because the producer (a
 * Temporal activity), the workflow, the prompt builders and the agent all read
 * it, and this package has no runtime dependencies — a workflow bundle can
 * import it.
 *
 * The text is also what the model reads, so it says what the material is and
 * how it may be used.
 */
export const VENDOR_CONTEXT_MARKER =
	"[Vendor profile: our own company material (capabilities, past work, case studies). Cite it only as evidence about us, never as a fact about the client or this project.]";

/**
 * What an exact copy of the marker inside the project's own context becomes.
 * Starts with `[`, the marker's only bracket, so no rewrite can splice a live
 * marker back together from the text around it; and it tells the model the
 * text is the project's, not ours.
 */
const DEFUSED_VENDOR_CONTEXT_MARKER =
	"[Project text quoting the vendor-profile label]";

/**
 * Rewrite every exact copy of the marker in a project context entry, so
 * project text that starts with it (a pasted prompt, an uploaded file) can
 * never pass for vendor material. Anything without the marker comes back
 * unchanged. Apply it to the project's entries only, before company entries
 * are appended: the company path is the one producer of marked entries.
 */
export function defuseVendorContextMarker(entry: string): string {
	return entry.replaceAll(
		VENDOR_CONTEXT_MARKER,
		DEFUSED_VENDOR_CONTEXT_MARKER,
	);
}

/** True when a context entry is company (vendor) material. */
export function isVendorContextEntry(entry: string): boolean {
	return entry.startsWith(VENDOR_CONTEXT_MARKER);
}

/** True when any entry is company (vendor) material. */
export function hasVendorContextEntries(
	entries: readonly string[] | undefined,
): boolean {
	return !!entries && entries.some(isVendorContextEntry);
}

/**
 * True when any entry is the project's own — anything that is not vendor
 * material. This is what "has RAG context" means wherever that decides the
 * prompt's shape.
 */
export function hasProjectContextEntries(
	entries: readonly string[] | undefined,
): boolean {
	return !!entries && entries.some((entry) => !isVendorContextEntry(entry));
}
