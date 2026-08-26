/**
 * Server-side mirror of the FE helper `extractStoryS3KeysFromContent` at
 * `apps/web/modules/saas/projects/lib/image-upload-utils.ts:331`.
 *
 * Lives in `packages/api/modules/projects/lib/` so the server-side
 * stage-transition guard can run without dragging in `apps/web` imports,
 * following the same precedent as `story-to-markdown.ts` (the bulk-download
 * procedure's mirror of the FE story-to-markdown helpers).
 *
 * Pure — no I/O, no React, no DOM. Two extraction paths are unified into a
 * single helper:
 *
 *   1. `data-s3-key="story-media/…"` — present while the description is
 *      still TipTap HTML (the autosave path).
 *   2. Bare `story-media/[^"'\s)]+` substring — present after the markdown
 *      round-trip via Turndown / model output, where `data-s3-key` has been
 *      stripped and only the signed URL path segment remains.
 *
 * The two paths cover both forms of the same key. The function deduplicates
 * via `Set<string>` and returns the keys in **left-to-right insertion order**
 * within the input string. Two intentional divergences from the FE precedent:
 *
 *   - Order: the FE runs the two extraction passes sequentially (all HTML
 *     attribute matches, then all bare-URL matches) because it only needs the
 *     set to re-sign URLs and is order-insensitive. The server-side guard
 *     reinjects dropped keys into an `## Attachments` block, where the
 *     original visual order of the input matters — so this helper interleaves
 *     the matches by character offset before deduping.
 *   - URL-key terminator: the FE bare-substring regex stops at `["'\s)]`,
 *     which is fine when the input is editor HTML (the `data-s3-key`
 *     attribute already carries the canonical key without query string). On
 *     the server we also see markdown like `![](https://…/story-media/k1?signed=…)`
 *     where the signed-URL query string follows the key. Stopping at `?` as
 *     well (and `&`) yields the canonical S3 key (`story-media/{project}/{story}/<filename>`,
 *     which never contains `?` or `&`), so dedupe across HTML and markdown
 *     forms of the same image works correctly.
 *
 * Idempotent by construction: running it twice on the same
 * input — including an input that already contains a reinjected
 * `## Attachments` block whose `![](signed-url)` markdown still embeds the
 * `story-media/…` substring — yields the same array.
 */

/** Matches `data-s3-key="..."` attributes. Capture group 1 = the key value. */
const DATA_S3_KEY_ATTR_REGEX = /data-s3-key="([^"]+)"/g;

/**
 * Matches bare `story-media/<...>` substrings (markdown / URL path form).
 * The character class excludes URL terminators (whitespace, `"`, `'`, `)`)
 * AND query-string delimiters (`?`, `&`) so the captured substring is the
 * canonical S3 key without any `?signed=…` suffix.
 */
const STORY_MEDIA_KEY_REGEX = /story-media\/[^"'\s)?&]+/g;

interface KeyMatch {
	key: string;
	index: number;
}

function collectAttrMatches(content: string): KeyMatch[] {
	const out: KeyMatch[] = [];
	DATA_S3_KEY_ATTR_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null = DATA_S3_KEY_ATTR_REGEX.exec(content);
	while (match !== null) {
		const key = match[1];
		if (key?.startsWith("story-media/")) {
			out.push({ key, index: match.index });
		}
		match = DATA_S3_KEY_ATTR_REGEX.exec(content);
	}
	return out;
}

function collectBareMatches(content: string): KeyMatch[] {
	const out: KeyMatch[] = [];
	STORY_MEDIA_KEY_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null = STORY_MEDIA_KEY_REGEX.exec(content);
	while (match !== null) {
		out.push({ key: match[0], index: match.index });
		match = STORY_MEDIA_KEY_REGEX.exec(content);
	}
	return out;
}

/**
 * Extract every distinct `story-media/<…>` S3 key referenced in a feature
 * description, preserving the order of first appearance in the input.
 *
 * Accepts `null` / `undefined` defensively because callers pass
 * `story.description`, which is nullable on `UserStory`. Empty input,
 * whitespace-only input, and input with no `story-media/` substring all
 * return `[]`.
 *
 * @param content The raw description string (HTML or markdown).
 * @returns Distinct `story-media/…` keys in first-appearance order.
 */
export function extractStoryMediaKeysFromContent(
	content: string | null | undefined,
): string[] {
	if (!content) {
		return [];
	}

	const combined = [
		...collectAttrMatches(content),
		...collectBareMatches(content),
	].sort((a, b) => a.index - b.index);

	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const { key } of combined) {
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		ordered.push(key);
	}
	return ordered;
}
