/**
 * Deterministic `StoryTag` value derivation for the security-finding-grouping
 * feature.
 *
 * `decisions.md`'s illustrative tag examples use colons
 * (`theme:security:owasp-a03-2021-injection`) as placeholders only —
 * `StoryTag.value` is constrained by the shared, existing
 * `tagValueSchema` / `ALLOWED_TAG_PATTERN` (`packages/utils/lib/tag-value.ts`):
 * `/^[\p{L}\p{N} _()/-]+$/u` (letters, digits, space, underscore, parens,
 * slash, hyphen — NO colon) and `MAX_TAG_LENGTH = 50`. This module produces
 * the concrete, hyphen-only, length-safe tag values that actually satisfy
 * that schema.
 *
 * `themeTagValue`'s 8-char sha256 hash suffix is not cosmetic: two different
 * `ruleSource` strings that share a long common prefix collapse to the same
 * 18-char truncated slug, so the hash is what keeps their tags distinct while
 * remaining fully deterministic (required for the rerun-dedup lookup,
 * `findOpenStoryByThemeTag`, to work at all).
 *
 * Length budget (worst case, ACCESSIBILITY = longest category slug):
 * "theme-"(6) + "accessibility"(13) + "-"(1) + slug(<=18) + "-"(1) + hash(8)
 * = 47 <= 50 (MAX_TAG_LENGTH).
 */

import { createHash } from "node:crypto";
import { normalizeTagValue } from "@repo/utils/tag-value";

/** The two theme categories a finding can belong to. */
export type GroupingTagCategory = "SECURITY" | "ACCESSIBILITY";

const CATEGORY_SLUG: Record<GroupingTagCategory, string> = {
	SECURITY: "security",
	ACCESSIBILITY: "accessibility",
};

/**
 * Reduce arbitrary text to a lowercase, hyphen-only fragment safe for
 * `ALLOWED_TAG_PATTERN`: NFKD-normalize, strip diacritics (combining marks
 * block, U+0300-U+036F), lowercase, collapse every run of non-alphanumeric
 * characters to a single hyphen, trim leading/trailing hyphens, then
 * truncate to 18 chars (see the file-header length budget). Kept as a
 * `RegExp` string constructor rather than a `/.../` literal — a bare
 * unicode-escape range in a regex literal is prone to being silently
 * mis-transcribed by tooling; the quoted string form is unambiguous.
 */
// biome-ignore lint/complexity/useRegexLiterals: see the doc comment above.
const DIACRITIC_MARK_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(input: string): string {
	return input
		.normalize("NFKD")
		.replace(DIACRITIC_MARK_PATTERN, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 18);
}

/** Short, tag-safe severity codes for severity-split sub-theme tags. */
const SEVERITY_CODE: Record<string, string> = {
	CRITICAL: "crit",
	HIGH: "high",
	MEDIUM: "med",
	LOW: "low",
};

/**
 * Deterministic, stable across reruns — the same `(category, ruleSource[,
 * severity])` always yields the same tag value. This is the sole, authoritative
 * dedup key used to decide whether a theme already has a ticket.
 *
 * When a large theme is split by severity (distribution), pass the finding's
 * severity: the hash input AND a short visible code both incorporate it, so
 * each severity slice gets its own stable identity. The 2-arg call is
 * byte-for-byte identical to the pre-split behaviour (no migration of existing
 * whole-theme tags). Length budget with severity (worst case ACCESSIBILITY):
 * "theme-"(6)+"accessibility"(13)+"-"+slug(<=12)+"-"+code(<=4)+"-"+hash(8) = 46 <= 50.
 */
export function themeTagValue(
	category: GroupingTagCategory,
	ruleSource: string,
	severity?: string | null,
): string {
	if (severity) {
		const sev = severity.toUpperCase();
		const code = SEVERITY_CODE[sev] ?? slugify(sev).slice(0, 4);
		const hash = createHash("sha256")
			.update(`${category}:${ruleSource}:${sev}`)
			.digest("hex")
			.slice(0, 8);
		return normalizeTagValue(
			`theme-${CATEGORY_SLUG[category]}-${slugify(ruleSource).slice(0, 12)}-${code}-${hash}`,
		);
	}
	const hash = createHash("sha256")
		.update(`${category}:${ruleSource}`)
		.digest("hex")
		.slice(0, 8);
	return normalizeTagValue(
		`theme-${CATEGORY_SLUG[category]}-${slugify(ruleSource)}-${hash}`,
	);
}

/**
 * Fixed sentinel tag for the self-filed "Fabric Agent access" prerequisite
 * ticket (D14) — no hash needed, it's a constant, not derived from variable
 * input. 40 chars.
 */
export const PREREQUISITE_ACCESS_TAG =
	"theme-prerequisite-security-agent-access";

/**
 * Fixed constant tag applied to every ticket generated from an ACCESSIBILITY
 * theme (D8, AC6) — signals the underlying rule may need tuning without
 * blocking ticket creation. 17 chars.
 */
export const NEEDS_RULE_REVIEW_TAG = "needs-rule-review";
