// Pure renderer: a READY publishing cycle -> a compact chat teaser (text).
// Structural input, no @repo/database dependency — mirrors
// render-newsletter-chat-message.ts, which is the shape a chat teaser already
// takes in this codebase.
//
// A SEPARATE renderer rather than a second caller of the newsletter's, for the
// reason 1C-3a's D1 gives about the target schema: these two produce messages
// for different features that are never read together, and mapping topics onto
// the newsletter's `highlights` would make one feature's copy change the
// other's output. What they legitimately share — the clipping rule — is shared,
// in ./chat-teaser-text.
import { truncateForChat } from "./chat-teaser-text";

export interface PublishingChatRenderTopic {
	title: string;
	/** FR9/10 short angle label. Null/absent for topics that have none. */
	angle?: string | null;
}
export interface PublishingChatRenderContent {
	projectName: string;
	topics: PublishingChatRenderTopic[];
}
export interface PublishingChatRenderOptions {
	platform: "TEAMS" | "SLACK";
	link?: string;
	maxTopics?: number;
}
export interface PublishingChatRenderResult {
	text: string;
}

/**
 * Escape the three characters Slack treats as mrkdwn control syntax, for
 * CONTENT interpolated into a message — never for the scaffolding this file
 * writes itself.
 *
 * Not defensive tidiness. Topic titles are LLM-generated from a corpus that
 * includes messages ingested from the very Slack channels this broadcast posts
 * to, so a title is attacker-influenceable text arriving in a room under a
 * trusted identity. Unescaped, `<!channel>` in a title notifies every member of
 * the room, and `<https://example.com|Reset your password>` renders as a
 * clickable link whose visible text is chosen by whoever wrote the source
 * message — under the Fabric integration on Slack, and under a colleague's own
 * account on Teams, since posts go out on the linker's delegated token.
 *
 * Slack only. The Teams path posts with `contentType: "text"`, which is not
 * markup, so escaping there would surface literal `&amp;` to the reader.
 */
function escapeSlackText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DEFAULT_MAX_TOPICS = 5;
// A broadcast is a TEASER, not the suggestion list: keep each field compact so a
// long LLM-generated title cannot flood a shared channel. Anything clipped is
// recoverable through the link, which is always appended when one is supplied.
const MAX_TITLE_CHARS = 140;
const MAX_ANGLE_CHARS = 60;
// The project name is user-supplied and previously had no budget at all, so a
// long one could push the whole teaser past what a channel shows before the
// topics were even reached.
const MAX_PROJECT_NAME_CHARS = 80;

export function renderPublishingChatMessage(
	content: PublishingChatRenderContent,
	opts: PublishingChatRenderOptions,
): PublishingChatRenderResult {
	const max = opts.maxTopics ?? DEFAULT_MAX_TOPICS;
	const isSlack = opts.platform === "SLACK";
	const lines: string[] = [];

	// Clip FIRST, then escape: the length budget is a property of the text a
	// reader sees, and escaping first would let three characters of `&amp;`
	// eat a title's budget — and could cut an entity in half at the boundary.
	const content_ = (s: string, max: number) => {
		const clipped = truncateForChat(s, max);
		return isSlack ? escapeSlackText(clipped) : clipped;
	};

	const heading = `New publishing ideas for ${content_(content.projectName, MAX_PROJECT_NAME_CHARS)}`;
	lines.push(isSlack ? `*${heading}*` : heading);

	const shown = content.topics.slice(0, max);
	if (shown.length > 0) {
		lines.push("");
		for (const t of shown) {
			const title = content_(t.title, MAX_TITLE_CHARS);
			const angle = t.angle
				? ` — ${content_(t.angle, MAX_ANGLE_CHARS)}`
				: "";
			lines.push(isSlack ? `• ${title}${angle}` : `- ${title}${angle}`);
		}
		const extra = content.topics.length - shown.length;
		if (extra > 0) {
			lines.push(isSlack ? `_…and ${extra} more_` : `…and ${extra} more`);
		}
	}

	if (opts.link) {
		lines.push("");
		lines.push(
			isSlack
				? `<${opts.link}|Review them in Fabric>`
				: `Review them in Fabric: ${opts.link}`,
		);
	}

	return { text: lines.join("\n") };
}
