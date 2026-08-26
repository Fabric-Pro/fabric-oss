/**
 * Mention parsing for the rich document editor. Mentions are stored as
 * inline spans with `data-type="mention"`, `data-id="<userId>"`, and
 * `data-mention-id="<anchor>"`. The anchor is a per-insertion id used
 * as the deep-link fragment (`#m-<anchor>`) so the recipient can be
 * scrolled to the exact spot in the document.
 */

import { type FunctionTag, isFunctionTag } from "@repo/database";

const SNIPPET_MAX_LENGTH = 280;

// Mention chips are leaf inline nodes in TipTap (text-only `@Name` content),
// so `[^<]*` is sufficient for chip body. If the editor ever allows nested
// marks inside the mention node (e.g. bold/italic on the chip text), relax
// this to `[\s\S]*?`.
const MENTION_SPAN_PATTERN =
	/<span\b[^>]*data-type=["']mention["'][^>]*>[^<]*<\/span>/gi;
const ATTR_PATTERN = /\b([a-z0-9-]+)=["']([^"']*)["']/gi;

export type DocumentMention = {
	userId: string;
	anchorId: string;
};

function parseAttrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	const matches = tag.matchAll(ATTR_PATTERN);
	for (const m of matches) {
		out[m[1]] = m[2];
	}
	return out;
}

/**
 * Pull every `<span data-type="mention" data-id data-mention-id>` from
 * the saved document HTML. Returns mentions in document order; duplicate
 * (userId, anchorId) pairs are collapsed.
 */
export function extractDocumentMentionIds(
	html: string | null | undefined,
): DocumentMention[] {
	if (!html) {
		return [];
	}
	const seen = new Set<string>();
	const out: DocumentMention[] = [];
	const matches = html.match(MENTION_SPAN_PATTERN) ?? [];
	for (const span of matches) {
		const attrs = parseAttrs(span);
		if (attrs["data-type"] !== "mention") {
			continue;
		}
		const userId = attrs["data-id"];
		const anchorId = attrs["data-mention-id"];
		if (!userId || !anchorId) {
			continue;
		}
		const key = `${userId}::${anchorId}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ userId, anchorId });
	}
	return out;
}

/**
 * Compute new mentions: users mentioned in `next` but not in `prev`.
 * Re-mentioning the same user with a different anchor is NOT counted —
 * we don't spam the recipient on every re-edit. The returned anchor is
 * the *first* occurrence in `next` so the deep-link points to the
 * earliest mention.
 */
export function diffMentionIds(
	prev: DocumentMention[],
	next: DocumentMention[],
): DocumentMention[] {
	const prevUsers = new Set(prev.map((m) => m.userId));
	const seen = new Set<string>();
	const out: DocumentMention[] = [];
	for (const m of next) {
		if (prevUsers.has(m.userId)) {
			continue;
		}
		if (seen.has(m.userId)) {
			continue;
		}
		seen.add(m.userId);
		out.push(m);
	}
	return out;
}

// Reserve a portion of the snippet budget for text that precedes the
// mention so the recipient sees a small lead-in. Remainder goes to the
// post-mention text where most of the meaningful context usually lives
// ("@Alice please review section three…").
const SNIPPET_LEAD_BUDGET = 80;

function stripTags(input: string): string {
	return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/**
 * Build a plain-text snippet centered on the given mention anchor. Used
 * as the notification body. Returns `""` when the anchor is not present
 * (caller falls back to a generic snippet like the document title).
 */
export function extractMentionContextSnippet(
	html: string | null | undefined,
	anchorId: string,
): string {
	if (!html) {
		return "";
	}
	const attrIdx = html.indexOf(`data-mention-id="${anchorId}"`);
	if (attrIdx < 0) {
		return "";
	}
	// Walk back to the opening `<` of the enclosing mention span so we
	// can split the document into before-mention and from-mention halves.
	const spanStart = html.lastIndexOf("<", attrIdx);
	if (spanStart < 0) {
		return "";
	}

	const beforePlain = stripTags(html.slice(0, spanStart)).trimEnd();
	const fromAnchorPlain = stripTags(html.slice(spanStart)).trimStart();

	const lead =
		beforePlain.length > SNIPPET_LEAD_BUDGET
			? `…${beforePlain.slice(-SNIPPET_LEAD_BUDGET).trimStart()}`
			: beforePlain;

	const remaining = SNIPPET_MAX_LENGTH - lead.length - 1;
	const tail =
		fromAnchorPlain.length > remaining
			? `${fromAnchorPlain.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`
			: fromAnchorPlain;

	return `${lead} ${tail}`.trim();
}

export type DocumentGroupMention = {
	tag: FunctionTag;
	anchorId: string;
};

/**
 * Pull every group mention span — `data-type="mention"` with a `data-group-tag`
 * and NO `data-id` — from saved HTML. User spans (which carry `data-id`) are
 * ignored by `extractDocumentMentionIds` already (it requires `data-id`), and
 * ignored here (they lack `data-group-tag`). Duplicate (tag, anchor) collapsed.
 */
export function extractDocumentGroupMentions(
	html: string | null | undefined,
): DocumentGroupMention[] {
	if (!html) {
		return [];
	}
	const seen = new Set<string>();
	const out: DocumentGroupMention[] = [];
	for (const span of html.match(MENTION_SPAN_PATTERN) ?? []) {
		const attrs = parseAttrs(span);
		if (attrs["data-type"] !== "mention") {
			continue;
		}
		// A group span carries data-group-tag and NO data-id. Reject a crafted
		// span with BOTH (updateDocument accepts arbitrary HTML) — otherwise it
		// would double as an individual @mention AND a group blast (Codex plan
		// review #3).
		if (attrs["data-id"]) {
			continue;
		}
		const tag = attrs["data-group-tag"];
		const anchorId = attrs["data-mention-id"];
		if (!tag || !anchorId || !isFunctionTag(tag)) {
			continue;
		}
		const key = `${tag}::${anchorId}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ tag, anchorId });
	}
	return out;
}

/**
 * Groups newly addressed in `next`: a group whose TAG was not present in
 * `prev` (point-in-time — a group already in the doc is not re-pinged on
 * re-save; a later-joining tag-holder is not retroactively notified). First
 * anchor per tag, mirroring `diffMentionIds`.
 */
export function diffGroupMentions(
	prev: DocumentGroupMention[],
	next: DocumentGroupMention[],
): DocumentGroupMention[] {
	const prevTags = new Set(prev.map((g) => g.tag));
	const seen = new Set<FunctionTag>();
	const out: DocumentGroupMention[] = [];
	for (const g of next) {
		if (prevTags.has(g.tag) || seen.has(g.tag)) {
			continue;
		}
		seen.add(g.tag);
		out.push(g);
	}
	return out;
}
