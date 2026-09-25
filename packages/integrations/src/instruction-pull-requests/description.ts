/**
 * Each provider's limit on a pull request's description, and the one
 * provider-specific formatter the limits require (Fizzy #2563 spec §10).
 *
 * The body the adapters receive is `renderPullRequestText`'s
 * (`@repo/instructions`): the escaped note (at most 4096 UTF-8 bytes), a
 * `---` paragraph, then a one-line attribution footer. Limits are counted
 * in UTF-16 code units, which is how each service measures a string's
 * length and what `String.prototype.length` counts. The values are the
 * providers' documented limits, not yet checked against recorded
 * responses (R19):
 *
 * - GitHub: 65,536 characters for a pull request body. The admitted body
 *   always fits, so GitHub gets it unchanged.
 * - GitLab: 1,048,576 characters for a merge request description. The
 *   admitted body always fits, so GitLab gets it unchanged.
 * - Azure DevOps: 4,000 characters for a pull request description, below
 *   what a 4096-byte note plus the footer can reach. Its body goes through
 *   `azureDevOpsDescription`, which shortens the note and never the footer.
 */

export const DESCRIPTION_LIMITS = {
	GITHUB: 65_536,
	GITLAB: 1_048_576,
	AZURE_DEVOPS: 4_000,
} as const;

export const AZURE_DEVOPS_DESCRIPTION_LIMIT = DESCRIPTION_LIMITS.AZURE_DEVOPS;

/** The paragraph break before the footer that `renderPullRequestText` writes. */
const FOOTER_SEPARATOR = "\n\n---\n\n";

/** Written where a note was shortened; plain text, so nothing escapes it. */
export const DESCRIPTION_SHORTENED_MARKER =
	"\n\n… (shortened to fit this provider's description limit)";

const isHighSurrogate = (code: number): boolean =>
	code >= 0xd800 && code <= 0xdbff;

/**
 * `text` cut to at most `length` code units, never between the halves of a
 * surrogate pair and never after a lone escaping backslash (an odd run of
 * trailing backslashes: `escapeMarkdown` doubles each literal one).
 */
function cutAt(text: string, length: number): string {
	let end = Math.max(0, Math.min(length, text.length));
	if (
		end > 0 &&
		end < text.length &&
		isHighSurrogate(text.charCodeAt(end - 1))
	) {
		end -= 1;
	}
	const kept = text.slice(0, end);
	const run = /\\+$/.exec(kept)?.[0].length ?? 0;
	return run % 2 === 1 ? kept.slice(0, -1) : kept;
}

/**
 * The body unchanged when it fits `limit`; otherwise the note before the
 * footer shortened, the marker, then the separator and footer exactly as
 * they were. Deterministic: the same body and limit give the same text.
 * The footer is found after the LAST separator, since a note may contain
 * its own `---` paragraph but the one-line footer cannot. A body with no
 * separator keeps its start.
 */
export function fitDescription(body: string, limit: number): string {
	if (body.length <= limit) {
		return body;
	}
	const at = body.lastIndexOf(FOOTER_SEPARATOR);
	const tail = at === -1 ? "" : body.slice(at);
	const note = at === -1 ? body : body.slice(0, at);
	const room = limit - tail.length - DESCRIPTION_SHORTENED_MARKER.length;
	if (room < 0) {
		// Only a footer longer than the whole limit gets here, which the
		// admitted footer (two names of at most 100 characters) never is.
		return cutAt(body, limit);
	}
	return `${cutAt(note, room)}${DESCRIPTION_SHORTENED_MARKER}${tail}`;
}

/** The description the Azure DevOps adapter sends. */
export function azureDevOpsDescription(body: string): string {
	return fitDescription(body, AZURE_DEVOPS_DESCRIPTION_LIMIT);
}
