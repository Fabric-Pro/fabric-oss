/**
 * The Fabric-owned attachment block inside a GitLab issue description
 * (Fizzy #1745, AC-1/AC-2).
 *
 * Fenced by HTML comments so it can be found again: the push regenerates it
 * wholesale and the pull strips it before the description reaches Fabric's
 * editor. Without a findable fence, a pulled block is re-imported into the
 * editor and the next push appends a second copy.
 *
 * Emitted as MARKDOWN, never HTML: the GitLab uploader only rewrites
 * `![alt](src)` / `[label](src)` forms, so an HTML block would never be
 * processed and would ship broken links.
 */
export const ATTACHMENT_BLOCK_OPEN = "<!-- fabric:attachments -->";
export const ATTACHMENT_BLOCK_CLOSE = "<!-- /fabric:attachments -->";

const PROTECTED_NOTE = "[Fabric protected attachment — not synced]";

/**
 * Escape the characters that would break a markdown link label, then
 * HTML-escape `<`/`>`.
 *
 * The second pass is not cosmetic: it is what stops a filename from being
 * able to spell the literal fence text. `sanitizeAttachmentFilename`
 * (packages/utils/lib/attachment.ts) only strips control characters, DEL,
 * and double-quotes — `<`, `>`, `!`, and `-` all survive — so a filename can
 * otherwise contain a real `<!-- /fabric:attachments -->` sequence. Because
 * `stripAttachmentBlock` matches non-greedily, that fake close marker would
 * be matched first, leaving the real close fence (and everything after it,
 * up to the next real close marker or end of string) un-stripped and
 * accumulating on every subsequent push.
 */
function escapeMarkdown(value: string): string {
	return value
		.replace(/([[\]()\\])/g, "\\$1")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function renderAttachmentBlock(input: {
	links: Array<{ filename: string; path: string }>;
	excluded: string[];
}): string {
	if (input.links.length === 0 && input.excluded.length === 0) {
		return "";
	}
	const lines: string[] = [ATTACHMENT_BLOCK_OPEN, "### Attachments"];
	for (const link of input.links) {
		lines.push(`- [${escapeMarkdown(link.filename)}](${link.path})`);
	}
	for (const filename of input.excluded) {
		lines.push(`- ${PROTECTED_NOTE} ${escapeMarkdown(filename)}`);
	}
	lines.push(ATTACHMENT_BLOCK_CLOSE);
	return lines.join("\n");
}

/**
 * Remove every Fabric attachment block. Non-greedy and global: a duplicate
 * block (from an older buggy push) is cleaned up rather than left to grow.
 * An unterminated open marker is left alone — eating to end-of-string would
 * silently delete a user's description.
 */
export function stripAttachmentBlock(description: string): string {
	if (!description) {
		return description;
	}
	const pattern = new RegExp(
		`\\n*${ATTACHMENT_BLOCK_OPEN}[\\s\\S]*?${ATTACHMENT_BLOCK_CLOSE}\\n*`,
		"g",
	);
	return description.replace(pattern, "\n\n");
}

export function appendAttachmentBlock(
	description: string,
	block: string,
): string {
	if (!block) {
		return description;
	}
	return `${description.replace(/\s+$/, "")}\n\n${block}`;
}
