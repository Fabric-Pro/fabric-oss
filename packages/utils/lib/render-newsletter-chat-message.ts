// Pure renderer: newsletter content -> a compact chat teaser (text + link).
// Structural input (no @repo/database dep — mirrors group-highlights.ts).
import { truncateForChat } from "./chat-teaser-text";

export interface ChatRenderHighlight {
	title: string;
}
export interface ChatRenderContent {
	headline: string;
	intro?: string;
	highlights: ChatRenderHighlight[];
}
export interface ChatRenderOptions {
	platform: "TEAMS" | "SLACK";
	link?: string;
	maxHighlights?: number;
}

/** v1 returns only `{ text }`. `attachments` is reserved for a future v2 (inline
 *  media) so that release can extend the return shape without a signature change. */
export interface ChatRenderResult {
	text: string;
	attachments?: unknown[];
}

const DEFAULT_MAX_HIGHLIGHTS = 5;
// A chat post is a TEASER, not the full newsletter: keep each field compact so a
// long LLM-generated intro or highlight title can't flood a channel. Anything
// clipped is recoverable via the "Read the full release notes" link, which is
// always appended (PO Q2, 2026-07-09: "always a portion + a link; truncate if
// too lengthy, users rely on the link for the rest").
const MAX_INTRO_CHARS = 240;
const MAX_HIGHLIGHT_CHARS = 140;

export function renderNewsletterChatMessage(
	content: ChatRenderContent,
	opts: ChatRenderOptions,
): ChatRenderResult {
	const max = opts.maxHighlights ?? DEFAULT_MAX_HIGHLIGHTS;
	const isSlack = opts.platform === "SLACK";
	const lines: string[] = [];

	lines.push(isSlack ? `*${content.headline}*` : content.headline);
	if (content.intro) {
		lines.push(truncateForChat(content.intro, MAX_INTRO_CHARS));
	}

	const shown = content.highlights.slice(0, max);
	if (shown.length > 0) {
		lines.push("");
		for (const h of shown) {
			const title = truncateForChat(h.title, MAX_HIGHLIGHT_CHARS);
			lines.push(isSlack ? `• ${title}` : `- ${title}`);
		}
		const extra = content.highlights.length - shown.length;
		if (extra > 0) {
			lines.push(isSlack ? `_…and ${extra} more_` : `…and ${extra} more`);
		}
	}

	if (opts.link) {
		lines.push("");
		lines.push(
			isSlack
				? `<${opts.link}|Read the full release notes>`
				: `Read the full release notes: ${opts.link}`,
		);
	}

	return { text: lines.join("\n") };
}
