/**
 * Slack huddle AI-notes canvas parsing.
 *
 * A huddle AI-notes canvas downloads (via `files:read`) as quip HTML — a small,
 * well-bounded subset of HTML: headings (h1–h6), bullet/numbered lists,
 * paragraphs, line breaks, and inline bold/italic. Slack emits per-line
 * timestamps inside the notes body. This module converts that subset to
 * markdown matching the Teams transcript header style.
 *
 * Everything here is PURE and dependency-free so it is trivially unit-testable
 * (Postgres / network are never touched). Mention resolution is split out: the
 * parser extracts `<@U…>` tokens, and a caller-supplied async resolver maps them
 * to display names (so the integration's cached `users.info` lookup is reused
 * rather than re-implemented).
 *
 * Security: never accepts or emits the bot token / url_private — it only ever
 * sees the already-downloaded HTML string.
 */

import { createHash } from "node:crypto";

/**
 * Mimetype Slack uses for the summary/notes canvas body (the artifact we
 * ingest). The verbatim huddle transcript (a different mimetype) is out of
 * scope — it has no bot-token API path.
 */
export const SLACK_DOCS_MIMETYPE = "application/vnd.slack-docs";

/** Slack canvas files surface as filetype `quip`. */
export const SLACK_CANVAS_FILETYPE = "quip";

// ---------------------------------------------------------------------------
// HTML entity decoding (the only entities quip canvases emit)
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Inline formatting: bold / italic. Run BEFORE stripping remaining tags so the
// markers survive into the output.
// ---------------------------------------------------------------------------

function convertInline(html: string): string {
	return (
		html
			// Bold
			.replace(
				/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
				"**$1**",
			)
			// Italic
			.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "_$1_")
	);
}

/** Strip any leftover tags and collapse intra-line whitespace. */
function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, ""))
		.replace(/[ \t\f\v]+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Block-level conversion
// ---------------------------------------------------------------------------

/**
 * Convert a quip-HTML canvas body to markdown.
 *
 * Preserves: headings (h1–h6 → #…######), bullet lists (ul/li → "- "),
 * numbered lists (ol/li → "1. "), paragraphs, inline bold/italic, and any
 * per-line timestamps Slack emits (they are plain text inside blocks, so they
 * survive untouched). Returns "" for empty / whitespace-only input — this drives
 * the downstream skip path (a just-posted, not-yet-populated canvas).
 */
export function quipHtmlToMarkdown(html: string | null | undefined): string {
	if (!html) {
		return "";
	}

	let working = html;

	// Drop document scaffolding that carries no notes content.
	working = working
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

	// Protect Slack mention tokens (`<@U…>` / `<@U…|name>`) BEFORE tag stripping,
	// otherwise the `<…>` is removed as if it were an HTML tag. We keep the
	// canonical `<@U…>` bracket form (placeholder-protected, restored after tag
	// stripping) so the downstream mention extractor/replacer matches the robust
	// bracket form rather than relying on the bare-token heuristic.
	const mentionPlaceholders: string[] = [];
	working = working.replace(
		/<@([A-Z0-9]+)(?:\|[^>]*)?>/g,
		(_m, id: string) => {
			const idx = mentionPlaceholders.push(`<@${id}>`) - 1;
			return `\0MENTION${idx}\0`;
		},
	);

	// Inline formatting first so the **/_ markers are preserved when tags strip.
	working = convertInline(working);

	// Headings.
	working = working.replace(
		/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_m, level: string, inner: string) => {
			const text = stripTags(inner);
			if (!text) {
				return "\n";
			}
			return `\n${"#".repeat(Number(level))} ${text}\n`;
		},
	);

	// Ordered lists — number their items sequentially.
	working = working.replace(
		/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi,
		(_m, inner: string) => {
			let n = 0;
			const items = inner.replace(
				/<li\b[^>]*>([\s\S]*?)<\/li>/gi,
				(_li, liInner: string) => {
					n += 1;
					const text = stripTags(liInner);
					return text ? `\n${n}. ${text}` : "";
				},
			);
			return `\n${items}\n`;
		},
	);

	// Unordered lists.
	working = working.replace(
		/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi,
		(_m, inner: string) => {
			const items = inner.replace(
				/<li\b[^>]*>([\s\S]*?)<\/li>/gi,
				(_li, liInner: string) => {
					const text = stripTags(liInner);
					return text ? `\n- ${text}` : "";
				},
			);
			return `\n${items}\n`;
		},
	);

	// Any stray <li> outside a recognized list → bullet.
	working = working.replace(
		/<li\b[^>]*>([\s\S]*?)<\/li>/gi,
		(_m, inner: string) => {
			const text = stripTags(inner);
			return text ? `\n- ${text}` : "";
		},
	);

	// Line breaks and paragraph boundaries → newlines.
	working = working
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<p\b[^>]*>/gi, "\n")
		.replace(/<\/div>/gi, "\n")
		.replace(/<div\b[^>]*>/gi, "\n");

	// Strip every remaining tag, decode entities.
	working = decodeEntities(working.replace(/<[^>]+>/g, ""));

	// Normalize whitespace: trim each line, collapse 3+ blank lines to 1.
	const lines = working
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v]+/g, " ").trimEnd());

	const out: string[] = [];
	let blankRun = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			blankRun += 1;
			if (blankRun <= 1) {
				out.push("");
			}
		} else {
			blankRun = 0;
			out.push(line.replace(/^ +/, ""));
		}
	}

	let rendered = out.join("\n").trim();

	// Restore protected mention tokens to their canonical `<@U…>` bracket form.
	rendered = rendered.replace(
		/MENTION(\d+)/g,
		(_m, idx: string) => mentionPlaceholders[Number(idx)] ?? _m,
	);

	return rendered;
}

// ---------------------------------------------------------------------------
// Slack mention resolution
// ---------------------------------------------------------------------------

const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>|(?<![\w])@(U[A-Z0-9]{6,})/g;

/**
 * Extract the distinct Slack user ids referenced by `<@U…>` or bare `@U…`
 * tokens in the given text, so a caller can resolve them in one batch.
 */
export function extractMentionUserIds(text: string): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(MENTION_RE)) {
		const id = match[1] ?? match[2];
		if (id) {
			ids.add(id);
		}
	}
	return [...ids];
}

/**
 * Replace `<@U…>` / bare `@U…` mention tokens with display names using a
 * pre-resolved id→name map. Unknown ids degrade gracefully to `@<id>`.
 */
export function replaceMentions(
	text: string,
	nameById: Map<string, string>,
): string {
	return text.replace(
		MENTION_RE,
		(_full, bracketId?: string, bareId?: string) => {
			const id = bracketId ?? bareId;
			if (!id) {
				return _full;
			}
			const name = nameById.get(id);
			return name ? `@${name}` : `@${id}`;
		},
	);
}

// ---------------------------------------------------------------------------
// Content hash (dedup anchor for update-in-place)
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of the parsed markdown body. A just-posted (empty) canvas
 * and a populated one hash differently, so the tracking row's stored hash drives
 * the "did it change since last poll" decision. Whitespace-normalized so trivial
 * re-renders don't churn the embedding.
 */
export function computeHuddleContentHash(body: string): string {
	const normalized = body.replace(/\r\n/g, "\n").trim();
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}
