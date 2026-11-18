/** The most Attendee accepts in one chat message. */
const ATTENDEE_MAX_CHAT_CHARS = 10_000;
/** The most of a post that is formatted; the bridge keeps its posts well under it. */
const MAX_CHAT_TEXT_CHARS = 4_096;
/**
 * A first paragraph this long, with more than one sentence, gives its first
 * sentence a line of its own, so the post opens with a short lead.
 */
const LEAD_PARAGRAPH_CHARS = 200;
/** The most a link's title may hold; a longer "title" is a sentence. */
const MAX_LINK_TITLE_CHARS = 80;
/** The most a bare address's label shows: its host and path. */
const MAX_URL_LABEL_CHARS = 48;
/**
 * An address, without the punctuation that ends the sentence after it. It
 * holds no `"`, so escaping it as text is enough inside the quoted `href`,
 * and no "…", which a shortened post adds right after its last address.
 */
const CHAT_URL = /https?:\/\/[^\s<>"…]*[^\s<>"'.,;:!?)\]…]/g;
/** A Markdown link, `[label](address)`, or else a bare address. */
const CHAT_LINK = new RegExp(
	`\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s()<>"]+)\\)|${CHAT_URL.source}`,
	"g",
);
/** "Title — address" or "Title: address": the title is the link. */
const TITLED_LINK = new RegExp(
	`^(.*?\\S)\\s*(?:[—–-]|:)\\s+(${CHAT_URL.source})([.,;…]?)$`,
);
/** A line that holds one address and nothing else but a list marker. */
const ADDRESS_LINE = new RegExp(
	`^(?:(?:•|[-*+]|\\d{1,3}[.)])\\s+)?(${CHAT_URL.source})([.,;…]?)$`,
);
/** How a sentence or a list introduction ends: such a line is not a title. */
const SENTENCE_END = /[.,;:!?…]$/;
/** What opens a line before its text: the post's tag, then a list marker ("• ", "1. "). */
const LINE_PREFIX = /^(?:\[P\d{1,6}\]\s+)?(?:(?:•|\d{1,3}\.)\s+)?/;
const HEADING = /^#{1,6}\s+/;

function escapeChatHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Cuts escaped HTML to `max` without leaving half an entity or a tag. */
function cutChatHtml(html: string, max: number): string {
	return html.length <= max
		? html
		: html.slice(0, max).replace(/&[a-z]*$|<[a-z]*$/, "");
}

/**
 * Markdown emphasis as Teams shows it: bold and italics become tags, code
 * marks go. Applied to text already escaped.
 */
function emphasisHtml(html: string): string {
	return html
		.replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "<b>$2</b>")
		.replace(/`([^`]+)`/g, "$1")
		.replace(
			/(^|[\s(])\*(\S(?:[^*]*?\S)?)\*(?=[\s).,;:!?]|$)/g,
			"$1<i>$2</i>",
		)
		.replace(/\*\*/g, "");
}

/** What a bare address shows: its host and path, cut short. */
function urlLabel(address: string): string {
	if (!URL.canParse(address)) {
		return address;
	}
	const url = new URL(address);
	const label = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
	return label.length > MAX_URL_LABEL_CHARS
		? `${label.slice(0, MAX_URL_LABEL_CHARS - 1)}…`
		: label;
}

function linkHtml(address: string, label: string): string {
	return `<a href="${escapeChatHtml(address)}">${label}</a>`;
}

/** A link's title as plain text: emphasis marks go, with no tags inside the link. */
function linkTitleHtml(title: string): string {
	return emphasisHtml(escapeChatHtml(title)).replace(/<\/?[bi]>/g, "");
}

function inlineHtml(text: string): string {
	let html = "";
	let last = 0;
	for (const match of text.matchAll(CHAT_LINK)) {
		const address = match[2] ?? match[0];
		const label =
			match[1] === undefined
				? escapeChatHtml(urlLabel(address))
				: emphasisHtml(escapeChatHtml(match[1])).replace(
						/<\/?[bi]>/g,
						"",
					);
		html += `${emphasisHtml(escapeChatHtml(text.slice(last, match.index)))}${linkHtml(address, label)}`;
		last = match.index + match[0].length;
	}
	return html + emphasisHtml(escapeChatHtml(text.slice(last)));
}

function lineHtml(line: string): string {
	const opening = LINE_PREFIX.exec(line)?.[0] ?? "";
	const prefix = escapeChatHtml(opening);
	const rest = line.slice(opening.length);
	if (HEADING.test(rest)) {
		return `${prefix}<b>${inlineHtml(rest.replace(HEADING, "")).replace(/<\/?b>/g, "")}</b>`;
	}
	const titled = TITLED_LINK.exec(rest);
	if (
		titled &&
		titled[1].length <= MAX_LINK_TITLE_CHARS &&
		!/https?:\/\//.test(titled[1])
	) {
		return `${prefix}${linkHtml(titled[2], linkTitleHtml(titled[1]))}${titled[3]}`;
	}
	return `${prefix}${inlineHtml(rest)}`;
}

/**
 * A title on one line and its address alone on the next, as "Overview" then
 * the Overview address: the pair becomes one titled link. A line that ends a
 * sentence or opens a list ("Here are the pages:"), holds an address of its
 * own, or is a heading is not a title.
 */
function titleLinkHtml(line: string, next: string | undefined): string | null {
	const address = next === undefined ? null : ADDRESS_LINE.exec(next);
	if (!address) {
		return null;
	}
	const opening = LINE_PREFIX.exec(line)?.[0] ?? "";
	const title = line.slice(opening.length);
	if (
		!title ||
		title.length > MAX_LINK_TITLE_CHARS ||
		HEADING.test(title) ||
		/https?:\/\//.test(title) ||
		SENTENCE_END.test(title)
	) {
		return null;
	}
	return `${escapeChatHtml(opening)}${linkHtml(address[1], linkTitleHtml(title))}${address[2]}`;
}

function paragraphHtml(lines: string[]): string {
	const html: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const titled = titleLinkHtml(lines[i], lines[i + 1]);
		if (titled) {
			html.push(titled);
			i++;
		} else {
			html.push(lineHtml(lines[i]));
		}
	}
	return `<p>${html.join("<br>")}</p>`;
}

/** Blank lines part paragraphs; each paragraph keeps its lines. */
function chatParagraphs(text: string): string[][] {
	const paragraphs = text
		.split(/\r?\n\s*\r?\n/)
		.map((paragraph) =>
			paragraph
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean),
		)
		.filter((lines) => lines.length > 0);
	const [first, ...rest] = paragraphs;
	if (first?.length !== 1 || first[0].length <= LEAD_PARAGRAPH_CHARS) {
		return paragraphs;
	}
	const lead = /^(.+?[.!?])\s+(?=\S)/.exec(first[0]);
	return lead
		? [[lead[1]], [first[0].slice(lead[0].length)], ...rest]
		: paragraphs;
}

/**
 * A post as Teams shows it. Attendee's Teams bot pastes a message with HTML
 * tags whole (plain text it types a key at a time, about 6 to 7 ms a
 * character, with the meeting audio held up meanwhile). Attendee documents
 * `<p>`, `<br>`, `<b>`, `<i>` and `<a>` for Teams, so a post uses only those:
 * - a short lead line, then a paragraph per blank-line block and a line per line;
 * - a list stays a list of lines ("•" or "1."), one item per line;
 * - "Title — address", a title line followed by a line holding only its
 *   address, and `[title](address)` link the title, and a bare address shows
 *   its host and path, never the full query string;
 * - Markdown headings and emphasis become bold or italics, never symbols.
 */
export function parlumeChatHtml(message: string): string {
	// Attendee rejects characters above U+FFFF (emoji); drop them before
	// cutting, so the cut cannot split a surrogate pair.
	const text = message
		.replace(/[\u{10000}-\u{10FFFF}]/gu, "")
		.slice(0, MAX_CHAT_TEXT_CHARS);
	const paragraphs = chatParagraphs(text);
	const html = paragraphs.map(paragraphHtml).join("");
	if (html.length <= ATTENDEE_MAX_CHAT_CHARS) {
		return html;
	}
	// Room for the `<p>` and `</p>` around the text.
	const plain = paragraphs.flat().map(escapeChatHtml).join("<br>");
	return `<p>${cutChatHtml(plain, ATTENDEE_MAX_CHAT_CHARS - 7)}</p>`;
}
