import { z } from "zod";

export const MAX_TAG_LENGTH = 50;
export const MAX_TAGS_PER_STORY = 20;

/**
 * Allowed tag characters: letters, digits, spaces, hyphen,
 * underscore, parentheses, forward slash. Commas are intentionally excluded
 * (multi-tag / URL-serialization safety). Unicode letters/numbers via \p{L}\p{N}.
 */
export const ALLOWED_TAG_PATTERN = /^[\p{L}\p{N} _()/-]+$/u;

/** Trim then lowercase — tags are case-insensitive and stored lowercase. */
export function normalizeTagValue(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Single source of truth for tag-value validation. Used server-side in
 * `tags.add` and client-side for inline errors. Transforms (normalizes) first,
 * then validates, so length/charset checks run against the stored value.
 */
export const tagValueSchema = z
	.string()
	.transform(normalizeTagValue)
	.refine((s) => s.length >= 1, { message: "Tag cannot be empty" })
	.refine((s) => s.length <= MAX_TAG_LENGTH, {
		message: `Tag must be at most ${MAX_TAG_LENGTH} characters`,
	})
	.refine((s) => !s.includes(","), { message: "Tag cannot contain commas" })
	.refine((s) => ALLOWED_TAG_PATTERN.test(s), {
		message: "Tag contains invalid characters",
	});
