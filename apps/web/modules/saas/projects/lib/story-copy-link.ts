/**
 * Pure helpers for constructing clipboard payloads when a user copies a
 * Fabric work-item link.  Kept separate from the component so the label /
 * escape / format logic is testable without rendering anything.
 */

export interface CopyLinkPayload {
	/** Human-readable label used as both the anchor text and plain-text prefix. */
	label: string;
	/** `<a href="…">…</a>` with all characters HTML-escaped (text/html MIME). */
	htmlContent: string;
	/** Plain-text fallback: `label — url` (text/plain MIME). */
	textContent: string;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Build the two clipboard payloads for a work-item share link.
 *
 * Label selection is type-aware:
 * - When `identifier` is a non-empty string (e.g. `"F-001"`), the label is
 *   `"F-001 Title"` — mirroring the Azure DevOps display convention.
 * - Otherwise the label is the plain `title`.
 *
 * All characters in the label and URL are HTML-escaped for the `text/html`
 * payload.  The `text/plain` payload uses the raw (unescaped) values.
 */
export function buildCopyLinkPayload(
	identifier: string | null | undefined,
	title: string,
	url: string,
): CopyLinkPayload {
	const label = identifier ? `${identifier} ${title}` : title;
	const htmlContent = `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
	const textContent = `${label} — ${url}`;
	return { label, htmlContent, textContent };
}
