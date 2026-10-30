/**
 * The resource-loading half of the diagram sanitizer (Fizzy #2946).
 *
 * DOMPurify's SVG profile removes what runs, not what loads: a fence's own
 * `style A fill:url(https://…)` reaches beautiful-mermaid's `fill` attribute
 * unchanged, and beautiful-mermaid's `<style>` opens with a Google Fonts
 * `@import`. Either makes every reader's browser fetch a URL the diagram's
 * author chose. These rules mirror the export's cleaner
 * (`packages/temporal/src/lib/proposal-export/clean-svg.ts`) for loads only:
 * a `url()` survives when it is a same-document `#id` reference, which is
 * how markers and gradients are drawn, and every at-rule is dropped. The
 * rest of a stylesheet (custom properties, `color-mix()`, `font-family`)
 * is left as written, because the live diagram's colours depend on it.
 */

/** A same-document reference: `url(#id)`, with optional spaces and quotes. */
const FRAGMENT_URL = /url\(\s*(["']?)\s*#[^"'()\s]*\s*\1\s*\)/g;

/** What loads a resource once the fragment references are gone. */
const LOADER =
	/url\s*\(|image-set\s*\(|(?<![a-z0-9_-])(?:image|src)\s*\(|@import/;

/**
 * Whether a CSS value, declaration or attribute value would load anything:
 * a `url()` that is not a same-document `#id`, `image-set()`, `image()`,
 * `src()` or `@import`. Comments are dropped and escapes decoded first, so
 * an escaped `\75 rl(` reads as the `url(` the browser sees.
 */
function loadsExternalResource(value: string): boolean {
	const normalized = decodeCssEscapes(
		value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ""),
	).toLowerCase();
	return LOADER.test(normalized.replace(FRAGMENT_URL, ""));
}

/**
 * Whether an attribute is kept: its value loads nothing and, on anything
 * but a link, an `href` is a same-document `#id`, so an `<image>` cannot
 * fetch a picture either.
 */
export function isInertDiagramAttribute(
	element: string,
	name: string,
	value: string,
): boolean {
	if (
		(name === "href" || name === "xlink:href") &&
		element.toLowerCase() !== "a" &&
		!value.trim().startsWith("#")
	) {
		return false;
	}
	return !loadsExternalResource(value);
}

/**
 * A stylesheet with every at-rule dropped with its block (`@import`,
 * `@font-face` …), every rule with a nested block or a loading selector
 * dropped, and every declaration that loads something dropped from its
 * rule. What remains is the input's own text, comments aside. Should any
 * load survive that, the whole stylesheet is dropped.
 */
export function cleanDiagramStylesheet(css: string): string {
	const text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
	let out = "";
	let index = 0;
	while (index < text.length) {
		const start = index;
		while (index < text.length && /\s/.test(text[index] ?? "")) {
			index++;
		}
		out += text.slice(start, index);
		if (index >= text.length) {
			break;
		}
		if (text[index] === "@") {
			index = skipAtRule(text, index);
			continue;
		}
		const open = scanTo(text, index, "{;}");
		if (open === -1) {
			// A prelude with no block declares nothing.
			break;
		}
		if (text[open] !== "{") {
			index = open + 1;
			continue;
		}
		const close = matchingBrace(text, open);
		const end = close === -1 ? text.length : close;
		const prelude = text.slice(index, open);
		const block = text.slice(open + 1, end);
		index = end + 1;
		if (scanTo(block, 0, "{") !== -1 || loadsExternalResource(prelude)) {
			continue;
		}
		const declarations = splitTopLevel(block, ";").filter(
			(declaration) => !loadsExternalResource(declaration),
		);
		out += `${prelude}{${declarations.join(";")}}`;
	}
	return loadsExternalResource(out) ? "" : out;
}

/** CSS escapes decoded: `\75 ` as `u`, `\(` as `(`, an escaped newline as nothing. */
function decodeCssEscapes(value: string): string {
	return value.replace(
		/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g,
		(_, hex: string | undefined, char: string | undefined) => {
			if (hex === undefined) {
				return char === "\n" ? "" : (char ?? "");
			}
			const code = Number.parseInt(hex, 16);
			return code === 0 ||
				code > 0x10ffff ||
				(code >= 0xd800 && code <= 0xdfff)
				? "�"
				: String.fromCodePoint(code);
		},
	);
}

/**
 * The index of the first of `stops` outside strings, parentheses and
 * escapes from `from`, or -1.
 */
function scanTo(text: string, from: number, stops: string): number {
	let depth = 0;
	for (let index = from; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char === "\\") {
			index++;
		} else if (char === '"' || char === "'") {
			index = skipString(text, index);
		} else if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && stops.includes(char)) {
			return index;
		}
	}
	return -1;
}

/** The index of the quote closing the string opened at `start`. */
function skipString(text: string, start: number): number {
	const quote = text[start];
	for (let index = start + 1; index < text.length; index++) {
		const char = text[index];
		if (char === "\\") {
			index++;
		} else if (char === quote || char === "\n") {
			return index;
		}
	}
	return text.length;
}

/** The index of the `}` closing the block opened at `open`, or -1. */
function matchingBrace(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index++) {
		const char = text[index];
		if (char === "\\") {
			index++;
		} else if (char === '"' || char === "'") {
			index = skipString(text, index);
		} else if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

/** The index just past the at-rule starting at `start`, block included. */
function skipAtRule(text: string, start: number): number {
	const stop = scanTo(text, start, ";{");
	if (stop === -1) {
		return text.length;
	}
	if (text[stop] === ";") {
		return stop + 1;
	}
	const close = matchingBrace(text, stop);
	return close === -1 ? text.length : close + 1;
}

/** `text` split on `separator` outside strings and parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (;;) {
		const stop = scanTo(text, start, separator);
		if (stop === -1) {
			parts.push(text.slice(start));
			return parts;
		}
		parts.push(text.slice(start, stop));
		start = stop + 1;
	}
}
