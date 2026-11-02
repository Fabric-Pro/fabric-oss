/**
 * What every visual template shares (Fizzy #2589, Fizzy #2946): the colour
 * placeholders and the card font, the Mermaid label escaping, and the label
 * helpers that wrap, cut and colour a node's text. `./visual-templates` and
 * `./visual-figure-templates` both build on this module, and neither of
 * them is imported here, so the three load in any order.
 *
 * No Node built-ins: same browser-safety rule as `./visual-templates`.
 */

// ---------------------------------------------------------------------------
// Shared: color placeholders and fonts
// ---------------------------------------------------------------------------

/**
 * Named color placeholders emitted into Mermaid `style` directives and SVG
 * `fill`/`stroke` attributes instead of literal hex values (KTD15: "colors
 * are placeholders that the browser fills with validated palette values").
 * This module has no dependency on `brand-colors.ts` or on an organization's
 * resolved palette — it only knows the token names. The browser substitutes
 * each token for a validated `#rrggbb` value before rendering, so a spec's
 * template output is stable across organizations and never embeds an
 * unvalidated color string. Plain identifier tokens (no `#`, spaces, commas,
 * or colons) so they are safe unescaped inside both an SVG attribute value
 * and a Mermaid `style ... fill:X,stroke:Y` list.
 */
export const VISUAL_COLOR_PLACEHOLDERS = {
	surface: "GLOSSY_COLOR_SURFACE",
	border: "GLOSSY_COLOR_BORDER",
	primary: "GLOSSY_COLOR_PRIMARY",
	ink: "GLOSSY_COLOR_INK",
	muted: "GLOSSY_COLOR_MUTED",
} as const;

/** One fixed system font stack for every SVG card, so text metrics are
 * predictable across organizations and platforms (KTD15). */
export const SVG_CARD_FONT_STACK =
	"system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Ends a label or line that was cut short. */
export const ELLIPSIS = "…";

// ---------------------------------------------------------------------------
// Mermaid label escaping
// ---------------------------------------------------------------------------

/**
 * U+200B, built via `fromCharCode` rather than typed as a literal character
 * so the source file contains no actual invisible code point — an invisible
 * character sitting directly in source is easy for an editor or a future
 * diff to lose track of.
 */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Sequences Mermaid acts on anywhere in a line or in the whole source, quoted
 * or not. Each pattern matches the part that gets a U+200B inserted after it
 * (a lookahead holds the rest), so the text still displays as typed but no
 * longer matches:
 * - `%%`: a `%%{init: ...}%%` directive is applied as configuration and cut
 *   out of the text wherever it appears, and one whose JSON does not parse
 *   discards every directive, the brand theme's included.
 * - `#` before `word;`: `#40;` and `#lt;` are Mermaid's entity codes.
 * - `<` before a tag name, `/`, `!`, or `?`: Mermaid rewrites `="..."` to
 *   `='...'` between a `<tag` and the next `>`, across lines, which can turn
 *   one label's closing quote and the next label's opening quote into `'`;
 *   the label sanitizer would also parse and rewrite the tag.
 * - `direction` before whitespace and `TB`, `BT`, `RL`, `LR`, or `TD`: the
 *   flowchart lexer's direction rules start with `.*`, so they match from
 *   the lexer's position to the end of the line, label included, and turn a
 *   node or subgraph line into a direction statement ("Strategic direction
 *   TBD"). Their `\s` is JavaScript's, so it also takes a tab or a
 *   non-breaking space. The flowchart lexer's rules are case-sensitive; the
 *   break ignores case anyway, as the same rules do in Mermaid's state, ER,
 *   and requirement lexers, and an extra break costs one invisible character.
 * - `C4` before `Container`, `Component`, `Dynamic`, or `Deployment`:
 *   Mermaid's C4 diagram detector matches those words anywhere in the source
 *   (only its `C4Context` alternative is anchored to the start) and runs
 *   before the flowchart one, so the whole visual would be parsed as a C4
 *   diagram and fail to render.
 * - `ﬂ°` and `¶ß` (U+FB02 U+00B0, U+00B6 U+00DF): Mermaid's internal form of
 *   an entity code. It turns every one in the finished SVG back into `&` or
 *   `;`, so a label holding them would draw a decoded entity (`ﬂ°lt¶ß` as
 *   `<`) or put a bare `&` into the SVG markup.
 */
const ZERO_WIDTH_BREAKS: readonly RegExp[] = [
	/%(?=%)/g,
	/#(?=\w+;)/g,
	/<(?=[\w/!?])/g,
	/direction(?=\s+(?:TB|BT|RL|LR|TD))/gi,
	/C4(?=Container|Component|Dynamic|Deployment)/g,
	/\uFB02(?=\u00B0)/g,
	/\u00B6(?=\u00DF)/g,
];

/**
 * A label that, unescaped, would read as Mermaid's own `click`/`style` line
 * directive, or, starting with a backtick right after the opening quote,
 * would open a Markdown string.
 */
const LEADING_KEYWORD_OR_BACKTICK = /^(?:(?:click|style)\b|`)/i;

/**
 * Straight double quotes as typographic ones, opening and closing in turn
 * so a quoted phrase reads naturally; an unpaired last quote closes.
 */
function typographicQuotes(text: string): string {
	const total = text.split('"').length - 1;
	let seen = 0;
	return text.replace(/"/g, () => {
		seen += 1;
		return seen % 2 === 1 && seen < total ? "“" : "”";
	});
}

/**
 * Escape a text label for interpolation into generated Mermaid source.
 *
 * Every template below writes a label inside double quotes (`id["label"]`,
 * `subgraph laneN["title"]`), and once the flowchart lexer reaches the
 * opening `"` its string state is exclusive: up to the next `"` it reads
 * everything as text. Quoting alone does not make a label inert, though:
 * before that quote the lexer is in its initial state, and it tries each of
 * that state's rules against the rest of the line, label included. Almost
 * all of them (`click`, `style`, `classDef`, `class`, `linkStyle`,
 * `interpolate`, `subgraph`, `end`, `accTitle`, `accDescr`, `href`, `call`,
 * `default`) match only at the lexer's position, which is never inside a
 * label, so brackets, parentheses, braces, `%`, `end`, and `click` inside
 * the quotes stay literal and as typed. The exceptions are the direction
 * rules, which start with `.*` (see `ZERO_WIDTH_BREAKS`). What can still
 * escape a label:
 * - a `"`, which would close the string early: replaced by typographic
 *   quotes (“ ”);
 * - a line break: folded to a space, because comment stripping runs line by
 *   line before the lexer, whatever the quoting;
 * - the sequences in `ZERO_WIDTH_BREAKS`, matched over a whole line or the
 *   whole source before the lexer reaches the label's quotes;
 * - a leading backtick, which would open a Markdown string: Markdown drops a
 *   link's text and rewrites formatting, and an unterminated one swallows
 *   the rest of the diagram.
 * A leading backtick and a leading `click`/`style` keyword (defense in depth
 * for a template that puts a label first on a line) are both prefixed with
 * U+200B rather than an ordinary space: a lexer commonly skips leading ASCII
 * whitespace, which would undo a plain-space prefix, but U+200B is outside
 * the `\s`/`trim()` class.
 *
 * One escape is for display only: Mermaid's SVG-text labels drop a `>` that
 * is not part of a `<…>` pair ("A -> B" would draw as "A - B"), so `>` is
 * written as `&gt;`, which they decode. A `<` needs no help: it sends the
 * label through the sanitizer, which escapes it.
 *
 * Fizzy #2589 follow-up: labels used to swap every syntax character for a
 * full-width look-alike, which the diagrams drew with wide built-in padding
 * ("leadership （Lead）", "85–90％"). Mermaid's own `#40;` entity codes are no
 * replacement: with SVG-text labels they reach the drawing undecoded.
 * Residual, display only: Mermaid drops the last `;` of a line matching
 * `style…:…#…;` or `classDef…:…#…;`, so a label of that shape loses a `;`,
 * or shows a `>` as `&gt`.
 */
export function escapeMermaidLabel(text: string): string {
	let escaped = typographicQuotes(text.replace(/\r\n|\r|\n/g, " ")).replace(
		/>/g,
		"&gt;",
	);
	for (const pattern of ZERO_WIDTH_BREAKS) {
		escaped = escaped.replace(pattern, `$&${ZERO_WIDTH_SPACE}`);
	}
	if (LEADING_KEYWORD_OR_BACKTICK.test(escaped.trim())) {
		escaped = `${ZERO_WIDTH_SPACE}${escaped}`;
	}
	return escaped;
}

// ---------------------------------------------------------------------------
// Template options and node labels
// ---------------------------------------------------------------------------

/**
 * How a Mermaid template draws (Fizzy #2946). Both default to Glossy's own
 * output, which stays exactly as it was; a Proposal passes
 * `PROPOSAL_VISUAL_TEMPLATE_OPTIONS`.
 * - `colorMode`: `"style"` writes a `style` line of colour placeholders per
 *   node; `"roles"` writes `class <id> surface` instead, so the fence holds
 *   no colour and the renderer paints the role from the theme at draw time.
 * - `layout`: `"proposal"` keeps labels short enough to read at page width
 *   (see `proposalNodeLabel`) and always draws a timeline top-down.
 * - `wrapTitle`: with the `"proposal"` layout, `false` writes a node's title
 *   as one label line instead of wrapping it, for a fence a figure template
 *   draws (see `proposalVisualTemplateOptions`). Glossy never reads it.
 */
export interface VisualTemplateOptions {
	colorMode?: "style" | "roles";
	layout?: "glossy" | "proposal";
	wrapTitle?: boolean;
}

export const PROPOSAL_VISUAL_TEMPLATE_OPTIONS = {
	colorMode: "roles",
	layout: "proposal",
} as const satisfies VisualTemplateOptions;

/** The longest line a Proposal diagram node shows, in characters. */
export const PROPOSAL_VISUAL_LINE_MAX_CHARS = 28;

/** How many lines a Proposal diagram node's title wraps to at most. */
export const PROPOSAL_VISUAL_TITLE_MAX_LINES = 2;

/**
 * A line break inside a quoted node label, which beautiful-mermaid and
 * mermaid.js both draw as a second line. Joined between labels that are
 * each escaped first, so the escaper never sees (and never breaks) it.
 */
const MERMAID_LABEL_BREAK = "<br/>";

/**
 * `text` cut to at most `max` characters: whitespace collapsed, and when
 * longer, cut back to the last word that fits, with an ellipsis. A fallback
 * only: the Proposal extraction asks for short labels, and what a cut shows
 * is still a prefix of what was fact-checked. Counts code points.
 */
export function cutLabelAtWord(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(collapsed);
	if (chars.length <= max) {
		return collapsed;
	}
	const room = chars.slice(0, max - 1).join("");
	// Cut at a word only when one ends in the latter half; otherwise the
	// first word alone is longer than the room and is broken.
	const lastSpace = room.lastIndexOf(" ");
	const kept =
		lastSpace >= Math.floor(room.length / 2)
			? room.slice(0, lastSpace)
			: room;
	return `${kept.replace(/[\s,;:.\-–—]+$/, "")}${ELLIPSIS}`;
}

/** Escaped label parts joined as lines; empty parts are left out. */
export function multilineLabel(
	parts: ReadonlyArray<string | undefined>,
): string {
	return parts
		.filter((part): part is string => Boolean(part?.trim()))
		.map(escapeMermaidLabel)
		.join(MERMAID_LABEL_BREAK);
}

/**
 * `text` wrapped at word boundaries into lines of at most `width`
 * characters, at most `maxLines` of them; the last line is cut with
 * `cutLabelAtWord` when words remain. A word longer than a line is broken.
 * Counts code points.
 */
function wrapLabelAtWords(
	text: string,
	width: number,
	maxLines: number,
): string[] {
	const lines: string[] = [];
	let rest = text.replace(/\s+/g, " ").trim();
	while (rest && lines.length < maxLines - 1) {
		const chars = Array.from(rest);
		if (chars.length <= width) {
			break;
		}
		const room = chars.slice(0, width + 1).join("");
		const lastSpace = room.lastIndexOf(" ");
		const line =
			lastSpace > 0
				? room.slice(0, lastSpace)
				: chars.slice(0, width).join("");
		lines.push(line.trimEnd());
		rest = rest.slice(line.length).trim();
	}
	if (rest) {
		lines.push(cutLabelAtWord(rest, width));
	}
	return lines;
}

/** Lower case, letters and digits only, single spaces: for comparing labels. */
function normaliseForComparison(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Whether a detail only repeats its title: one contains the other as whole
 * words once case, punctuation and spacing are ignored. Models often put the
 * source bullet in the detail and a shortened copy of it in the title.
 */
export function detailRepeatsTitle(title: string, detail: string): boolean {
	// Padded so only whole words match: "plan" is not found in "planning".
	const normalTitle = ` ${normaliseForComparison(title)} `;
	const normalDetail = ` ${normaliseForComparison(detail)} `;
	if (!normalTitle.trim() || !normalDetail.trim()) {
		return false;
	}
	return (
		normalDetail.includes(normalTitle) || normalTitle.includes(normalDetail)
	);
}

/**
 * A Proposal node's label lines (Fizzy #2946), each at most
 * `PROPOSAL_VISUAL_LINE_MAX_CHARS`: a timeline's date on its own line, the
 * title wrapped at words to at most two lines, then at most one detail line.
 * A detail that repeats the title is left out. A longer detail is cut at a
 * word with an ellipsis rather than dropped, so what it adds still shows;
 * the extraction asks for one that needs no cut. Every line shown is a
 * prefix of the text that was checked.
 *
 * Without `wrapTitle` the title is one line cut at the same two-line budget:
 * a figure template reads only the first line after the date as the title
 * and wraps it to its own width, so a second title line would draw as
 * detail.
 */
export function proposalNodeLabel(
	title: string,
	detail: string | undefined,
	wrapTitle: boolean,
	date?: string,
): string {
	const width = PROPOSAL_VISUAL_LINE_MAX_CHARS;
	const lines = date ? [cutLabelAtWord(date, width)] : [];
	if (wrapTitle) {
		lines.push(
			...wrapLabelAtWords(title, width, PROPOSAL_VISUAL_TITLE_MAX_LINES),
		);
	} else {
		lines.push(
			cutLabelAtWord(title, width * PROPOSAL_VISUAL_TITLE_MAX_LINES),
		);
	}
	if (detail?.trim() && !detailRepeatsTitle(title, detail)) {
		lines.push(cutLabelAtWord(detail, width));
	}
	return multilineLabel(lines);
}

/** A node's colour line: placeholder `style`, or its role class. */
export function nodeColorLine(
	id: string,
	options: VisualTemplateOptions,
): string {
	return options.colorMode === "roles"
		? `class ${id} surface`
		: `style ${id} fill:${VISUAL_COLOR_PLACEHOLDERS.surface},stroke:${VISUAL_COLOR_PLACEHOLDERS.border}`;
}

/**
 * A chain of rectangle nodes, one per item, in order, each linked to the
 * next. Node ids are `<idPrefix><index>`, never text from the spec.
 * `labelOf` returns the label already escaped.
 */
