/**
 * Converts Confluence storage format XHTML into Markdown.
 * Shared by background connector sync and the in-app Confluence page browser.
 */

// Keep code-block text: unwrap CDATA and escape "&" and "<" so later conversions leave it alone
function unwrapCdata(s: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const start = s.indexOf("<![CDATA[", i);
		if (start === -1) {
			return out + s.slice(i);
		}
		const end = s.indexOf("]]>", start + 9);
		if (end === -1) {
			return out + s.slice(i);
		}
		out +=
			s.slice(i, start) +
			s
				.slice(start + 9, end)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;");
		i = end + 3;
	}
}

export function convertConfluenceXhtmlToMarkdown(xhtml: string): string {
	let md = xhtml;

	md = unwrapCdata(md);

	// Headings
	md = md.replace(/<h1(?:\s[^<>]*)?>/gi, "# ");
	md = md.replace(/<\/h1>/gi, "\n");
	md = md.replace(/<h2(?:\s[^<>]*)?>/gi, "## ");
	md = md.replace(/<\/h2>/gi, "\n");
	md = md.replace(/<h3(?:\s[^<>]*)?>/gi, "### ");
	md = md.replace(/<\/h3>/gi, "\n");
	md = md.replace(/<h4(?:\s[^<>]*)?>/gi, "#### ");
	md = md.replace(/<\/h4>/gi, "\n");

	// Paragraphs and line breaks
	md = md.replace(/<p(?:\s[^<>]*)?>/gi, "");
	md = md.replace(/<\/p>/gi, "\n\n");
	md = md.replace(/<br\s*\/?>/gi, "\n");

	// List items
	md = md.replace(/<li(?:\s[^<>]*)?>/gi, "- ");
	md = md.replace(/<\/li>/gi, "\n");

	// Formatting (bold, italic, code)
	md = md.replace(/<strong(?:\s[^<>]*)?>/gi, "**");
	md = md.replace(/<\/strong>/gi, "**");
	md = md.replace(/<b(?:\s[^<>]*)?>/gi, "**");
	md = md.replace(/<\/b>/gi, "**");
	md = md.replace(/<em(?:\s[^<>]*)?>/gi, "*");
	md = md.replace(/<\/em>/gi, "*");
	md = md.replace(/<i(?:\s[^<>]*)?>/gi, "*");
	md = md.replace(/<\/i>/gi, "*");
	md = md.replace(/<code(?:\s[^<>]*)?>/gi, "`");
	md = md.replace(/<\/code>/gi, "`");

	// Links
	md = md.replace(/<a\s([^<>]*)>([^<]*)<\/a>/gi, (match, attrs, text) => {
		const hrefMatch = attrs.match(/\bhref="([^"]*)"/i);
		if (hrefMatch) {
			return `[${text}](${hrefMatch[1]})`;
		}
		return match;
	});

	// Strip remaining HTML tags
	md = md.replace(/<[^<>]+>/g, "");

	// Entities
	md = md.replace(/&nbsp;/g, " ");
	md = md.replace(/&lt;/g, "<");
	md = md.replace(/&gt;/g, ">");
	md = md.replace(/&quot;/g, '"');
	md = md.replace(/&amp;/g, "&");

	// Normalize whitespace
	md = md.replace(/\n{3,}/g, "\n\n");
	return md.trim();
}
