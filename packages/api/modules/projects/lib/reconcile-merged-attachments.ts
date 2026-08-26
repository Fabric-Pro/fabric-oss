// Attachment safety for the duplicate "true merge".
//
// Story media is STORY-scoped: `resolveMediaUrls` rejects any key that is not
// under `story-media/{projectId}/{storyId}/`. So when a duplicate-merge applies
// an AI-combined description to the survivor, the combined text:
//   - must NOT carry the duplicate's ORIGINAL image keys (they live in a
//     different story's keyspace and would render broken on the survivor), and
//   - must NOT silently drop the survivor's OWN images (the model is free to
//     omit raw image links, and the per-field input cap can truncate trailing
//     keys before the model ever sees them).
//
// `reconcileMergedDescriptionAttachments` makes the result deterministic and
// lossless w.r.t. BOTH items' images: it strips every story-media image
// reference from the AI output and re-appends the survivor's own keys (read
// from its prior description) PLUS the keys the merge copied out of the
// duplicate into the survivor's keyspace, as a `## Attachments` block — the same
// canonical bare-key form `appendAttachmentsSection` produces everywhere else,
// which the editor signs on load via `resolveMediaUrls`. Pure (no I/O),
// idempotent.
//
// Fizzy #2048: the duplicate's images used to be dropped here, because a merge
// had no way to make a duplicate's key resolve on the survivor. It does now —
// `copyStoryAssetsToStory` copies the object into the survivor's keyspace and
// hands the NEW key to `carriedMediaKeys`. This function never resolves or
// copies anything itself; it re-appends keys the caller has already proven to
// exist, and still emits nothing outside the survivor's own prefix.

import { appendAttachmentsSection } from "./append-attachments-section";
import { extractStoryMediaKeysFromContent } from "./extract-story-media-keys";

/** Markdown image OR link: `![alt](url)` / `[text](url)`. */
const MD_LINK_OR_IMAGE_RE = /!?\[[^\]]*\]\([^)]*\)/g;
/** HTML `<img ...>` tag (covers `data-s3-key` / `src` forms). */
const HTML_IMG_RE = /<img\b[^>]*>/gi;
/** Bare `story-media/<...>` substring (stops before query string / delimiters). */
const BARE_KEY_RE = /story-media\/[^"'\s)?&]+/g;

/**
 * Remove every `story-media/` image/link reference from a markdown string,
 * leaving non-story-media images (e.g. pasted external URLs) untouched.
 * Collapses blank-line runs left behind by removals.
 */
export function stripStoryMediaImages(text: string | null | undefined): string {
	if (!text) {
		return "";
	}
	const cleaned = text
		.replace(MD_LINK_OR_IMAGE_RE, (m) =>
			m.includes("story-media/") ? "" : m,
		)
		.replace(HTML_IMG_RE, (m) => (m.includes("story-media/") ? "" : m))
		.replace(BARE_KEY_RE, "");
	return cleaned
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Produce the description to persist on the survivor after an AI-combined merge,
 * guaranteeing that BOTH items' images survive and that no broken (cross-story)
 * image reference is written.
 *
 *   1. Strip every story-media image reference from the combined text.
 *   2. Re-append the survivor's OWN keys extracted from its prior description,
 *      then the keys copied out of the duplicate (`carriedMediaKeys`), via
 *      `appendAttachmentsSection` (idempotent, bare-key form).
 *
 * Both sets are filtered to `story-media/{projectId}/{survivorId}/` before they
 * are written. For the survivor's own keys that filter drops the duplicate's
 * originals; for the carried keys it is defence in depth — they are already
 * survivor-scoped by construction, and this function stays the single place that
 * guarantees the persisted body references nothing outside the survivor's
 * keyspace.
 *
 * Returns the combined text unchanged-but-stripped when neither item has
 * attachments. Callers should treat an empty result as "don't overwrite" (so a
 * description that was only images is never reduced to nothing).
 */
export function reconcileMergedDescriptionAttachments(params: {
	mergedDescription: string;
	survivorPriorDescription: string | null | undefined;
	projectId: string;
	survivorId: string;
	/**
	 * Keys the merge COPIED from the duplicate into the survivor's keyspace —
	 * the new (survivor-prefixed) keys, never the duplicate's originals. Only
	 * keys whose copy actually succeeded belong here; see
	 * `copyStoryAssetsToStory`. Omitted for a merge that carries nothing.
	 */
	carriedMediaKeys?: readonly string[];
}): string {
	const {
		mergedDescription,
		survivorPriorDescription,
		projectId,
		survivorId,
		carriedMediaKeys = [],
	} = params;
	const prefix = `story-media/${projectId}/${survivorId}/`;

	const base = stripStoryMediaImages(mergedDescription);

	const ownKeys = extractStoryMediaKeysFromContent(
		survivorPriorDescription,
	).filter((key) => key.startsWith(prefix));

	// Survivor's own keys first (its body order is the one the user knows), then
	// the carried ones. Deduplicated so a key present in both lists is written
	// once — `appendAttachmentsSection` is idempotent against the text, not
	// against a repeated input entry.
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const key of [...ownKeys, ...carriedMediaKeys]) {
		if (!key.startsWith(prefix) || seen.has(key)) {
			continue;
		}
		seen.add(key);
		keys.push(key);
	}
	if (keys.length === 0) {
		return base;
	}

	return appendAttachmentsSection(
		base,
		keys.map((s3Key) => ({
			s3Key,
			name: s3Key.split("/").pop() ?? "attachment",
		})),
	);
}
