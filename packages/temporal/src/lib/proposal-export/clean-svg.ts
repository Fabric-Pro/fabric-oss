/**
 * The allowlist a rendered diagram passes before the Proposal export inlines
 * it (Fizzy #2946).
 *
 * beautiful-mermaid draws diagrams as plain SVG markup, but its output is not
 * safe to put on a print page as it is:
 *
 * - its one `<style>` opens with an unconditional Google Fonts `@import` and
 *   carries unscoped `text {…}` and `svg {…}` rules, which would restyle the
 *   whole page and every other diagram on it;
 * - its marker ids are fixed strings (`arrowhead`), so two diagrams on one
 *   page point at each other's arrows;
 * - a fence's own `style A fill:url(http://…)` or `linkStyle 0 stroke:url(…)`
 *   reaches `fill` and `stroke` attributes unchanged, which makes Chromium
 *   reach for the URL.
 *
 * So the markup is parsed as XML and rebuilt from allowlists: known inert
 * elements, known attributes whose values are colours, numbers, path data or
 * same-document `url(#id)` references, and a stylesheet re-tokenized into
 * scoped rules of custom properties and presentation properties. Every id is
 * prefixed with the diagram's scope and every reference rewritten to match,
 * every class gets a fixed prefix so the page's own stylesheet cannot style
 * a diagram's parts, and every text and attribute value is escaped on the way
 * out. What the allowlists do not name is dropped, never repaired; markup
 * that does not parse, or has no usable size, is refused outright and the
 * caller prints the diagram's placeholder.
 *
 * The output is well-formed XML that parses the same way inlined into an
 * HTML page: no element in it is one the HTML parser breaks out of SVG for,
 * and nothing in a text node or attribute can read as markup.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { PROPOSAL_EXPORT_LIMITS } from "./types";

export interface CleanedDiagramSvg {
	svg: string;
	/** Intrinsic size in CSS pixels, from the viewBox. */
	width: number;
	height: number;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** A diagram larger than this on either edge is not a real diagram. */
const MAX_DIAGRAM_EDGE = 20_000;

/** Prefix of every class, so page rules such as `.node` never match a part. */
const DIAGRAM_CLASS_PREFIX = "dg-";

const SCOPE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** An id or fragment the cleaner keeps; beautiful-mermaid's all match. */
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

const CLASS_PATTERN = /^[A-Za-z_-][A-Za-z0-9_-]{0,100}$/;

/**
 * Every element beautiful-mermaid 1.1.3 draws for flowchart, state,
 * sequence, class, ER and XY diagrams, plus `title` and `desc`. All inert:
 * none loads anything, runs anything, or makes the HTML parser leave SVG.
 * The root `svg` is handled on its own; a nested one is dropped.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
	"g",
	"defs",
	"marker",
	"path",
	"line",
	"polyline",
	"polygon",
	"rect",
	"circle",
	"ellipse",
	"text",
	"tspan",
	"style",
	"title",
	"desc",
]);

/** Elements whose text content is drawn; text anywhere else is dropped. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set([
	"text",
	"tspan",
	"title",
	"desc",
]);

/**
 * Elements that keep text only. `title` and `desc` are HTML integration
 * points: an element inside one would be parsed as HTML when inlined.
 */
const TEXT_ONLY_ELEMENTS: ReadonlySet<string> = new Set(["title", "desc"]);

/**
 * Attributes kept when their value passes {@link safeValue}: geometry,
 * presentation and marker attributes. `id`, `class`, `href` and
 * `font-family` have their own rules; `style` is kept on the root only,
 * where beautiful-mermaid writes its colour variables, and so is `role`
 * when it is `img`, as a figure template writes it. Everything else,
 * `on*` handlers and beautiful-mermaid's `data-*` bookkeeping included, is
 * dropped.
 */
const VALUE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"dx",
	"dy",
	"width",
	"height",
	"d",
	"points",
	"transform",
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"opacity",
	"font-size",
	"font-weight",
	"font-style",
	"text-anchor",
	"dominant-baseline",
	"alignment-baseline",
	"letter-spacing",
	"text-decoration",
	"markerWidth",
	"markerHeight",
	"markerUnits",
	"refX",
	"refY",
	"orient",
	"marker-start",
	"marker-mid",
	"marker-end",
	"vector-effect",
]);

/** Properties a kept stylesheet rule may set, beside custom properties. */
const CSS_PROPERTIES: ReadonlySet<string> = new Set([
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"opacity",
	"color",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"letter-spacing",
	"text-anchor",
	"dominant-baseline",
	"text-decoration",
]);

/**
 * Functions a value may call. None of them loads anything; `url()` is
 * further limited to a same-document `#id`.
 */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
	"var",
	"color-mix",
	"rgb",
	"rgba",
	"hsl",
	"hsla",
	"url",
	"translate",
	"rotate",
	"scale",
	"matrix",
	"skewx",
	"skewy",
]);

/**
 * Every character a kept value may hold: enough for colours, numbers, path
 * data, transforms, `var()` and `color-mix()`. No quote, backslash (a CSS
 * escape could spell `url(`), `<`, `>`, `&`, `@`, `:`, `;`, `/` or brace.
 */
const SAFE_VALUE = /^[A-Za-z0-9#%.,()\s_+-]*$/;

/** CSS generic families, written unquoted so they stay keywords. */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-serif",
	"ui-sans-serif",
	"ui-monospace",
	"ui-rounded",
	"math",
	"emoji",
]);

const FAMILY_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,62}$/;

/** A parsed node of fast-xml-parser's `preserveOrder` output. */
type XmlNode = Record<string, unknown>;

const ATTRIBUTE_PREFIX = "@_";
const ATTRIBUTES_KEY = ":@";
const TEXT_KEY = "#text";
const CDATA_KEY = "#cdata";

/**
 * Raw values: entities are not decoded by the parser (a DOCTYPE could
 * otherwise declare one that expands to markup), numbers are not parsed,
 * whitespace is kept, and comments, processing instructions and the XML
 * declaration are dropped.
 */
const PARSER_OPTIONS = {
	preserveOrder: true,
	ignoreAttributes: false,
	attributeNamePrefix: ATTRIBUTE_PREFIX,
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: false,
	processEntities: false,
	htmlEntities: false,
	cdataPropName: CDATA_KEY,
	commentPropName: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
} as const;

/**
 * The cleaned SVG, or null when it is refused: too long, not well-formed,
 * not exactly one root `<svg>`, or without a usable size. The same input
 * always cleans to the same output.
 *
 * `scopeId` becomes the root's id and the prefix of every id inside it, so
 * it must be unique per diagram on a page: letters, digits, hyphens and
 * underscores, starting with a letter.
 */
export function cleanDiagramSvg(
	svg: string,
	options: { scopeId: string },
): CleanedDiagramSvg | null {
	const { scopeId } = options;
	if (!SCOPE_ID_PATTERN.test(scopeId)) {
		throw new TypeError("cleanDiagramSvg: invalid scopeId");
	}
	if (svg.length > PROPOSAL_EXPORT_LIMITS.maxSvgLength) {
		return null;
	}
	try {
		if (XMLValidator.validate(svg) !== true) {
			return null;
		}
		const parsed: unknown = new XMLParser(PARSER_OPTIONS).parse(svg);
		if (!Array.isArray(parsed)) {
			return null;
		}
		const roots = parsed.filter((node) => !isWhitespaceText(node));
		const root = roots.length === 1 ? readElement(roots[0]) : null;
		if (!root || root.name !== "svg") {
			return null;
		}
		const size = readSize(root.attributes);
		if (!size) {
			return null;
		}
		const cleaner = new SvgCleaner(scopeId);
		const body = cleaner.children(root.children, "svg");
		const style = cleaner.stylesheet();

		const rootAttributes: [string, string][] = [
			["xmlns", SVG_NAMESPACE],
			["id", scopeId],
			["viewBox", size.viewBox],
			["width", formatNumber(size.width)],
			["height", formatNumber(size.height)],
		];
		// A figure template is an image to assistive technology; `img` is the
		// only role kept, so markup cannot claim to be a control.
		if (root.attributes.role?.trim() === "img") {
			rootAttributes.push(["role", "img"]);
		}
		const rootStyle = cleanRootStyle(root.attributes.style ?? "", scopeId);
		if (rootStyle) {
			rootAttributes.push(["style", rootStyle]);
		}
		const styleElement = style
			? `\n<style>${escapeText(style)}</style>`
			: "";
		return {
			svg: `<svg${serializeAttributes(rootAttributes)}>${styleElement}${body}</svg>`,
			width: size.width,
			height: size.height,
		};
	} catch {
		return null;
	}
}

interface ParsedElement {
	name: string;
	/** Attribute values, entities decoded. */
	attributes: Record<string, string>;
	children: unknown[];
}

/** One element of the parser's output, or null for any other shape. */
function readElement(node: unknown): ParsedElement | null {
	if (!isRecord(node)) {
		return null;
	}
	const names = Object.keys(node).filter((key) => key !== ATTRIBUTES_KEY);
	const name = names.length === 1 ? names[0] : undefined;
	if (name === undefined || name === TEXT_KEY || name === CDATA_KEY) {
		return null;
	}
	const children = node[name];
	if (!Array.isArray(children)) {
		return null;
	}
	const attributes: Record<string, string> = Object.create(null);
	const raw = node[ATTRIBUTES_KEY];
	if (isRecord(raw)) {
		for (const [key, value] of Object.entries(raw)) {
			if (key.startsWith(ATTRIBUTE_PREFIX) && typeof value === "string") {
				attributes[key.slice(ATTRIBUTE_PREFIX.length)] =
					decodeXml(value);
			}
		}
	}
	return { name, attributes, children };
}

function isRecord(value: unknown): value is XmlNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhitespaceText(node: unknown): boolean {
	return (
		isRecord(node) &&
		Object.keys(node).length === 1 &&
		typeof node[TEXT_KEY] === "string" &&
		node[TEXT_KEY].trim() === ""
	);
}

/** The text of a CDATA node, taken literally, or null. */
function readCdata(node: XmlNode): string | null {
	const content = node[CDATA_KEY];
	if (!Array.isArray(content)) {
		return null;
	}
	return content
		.map((part) =>
			isRecord(part) && typeof part[TEXT_KEY] === "string"
				? part[TEXT_KEY]
				: "",
		)
		.join("");
}

/** Walks the tree once, collecting every stylesheet as it goes. */
class SvgCleaner {
	private readonly css: string[] = [];

	constructor(private readonly scopeId: string) {}

	/** The kept children of an element named `parent`, serialized. */
	children(nodes: readonly unknown[], parent: string): string {
		let out = "";
		for (const node of nodes) {
			out += this.node(node, parent);
		}
		return out;
	}

	/** Every collected stylesheet as one set of scoped rules, or "". */
	stylesheet(): string {
		const rules = this.css.flatMap((css) =>
			cleanStylesheet(css, this.scopeId),
		);
		return rules.length > 0 ? `\n${rules.join("\n")}\n` : "";
	}

	private node(node: unknown, parent: string): string {
		if (!isRecord(node)) {
			return "";
		}
		const text = this.text(node, parent);
		if (text !== null) {
			return text;
		}
		const element = readElement(node);
		if (!element || !ALLOWED_ELEMENTS.has(element.name)) {
			return "";
		}
		if (TEXT_ONLY_ELEMENTS.has(parent)) {
			return "";
		}
		if (element.name === "style") {
			// Collected and merged into the one stylesheet the root carries.
			this.css.push(this.textContent(element.children));
			return "";
		}
		const attributes = serializeAttributes(
			this.attributes(element.attributes),
		);
		const children = this.children(element.children, element.name);
		return children === ""
			? `<${element.name}${attributes} />`
			: `<${element.name}${attributes}>${children}</${element.name}>`;
	}

	/**
	 * A text or CDATA node, serialized, or null when `node` is neither.
	 * Text is kept inside drawn text elements; elsewhere only whitespace,
	 * the indentation between elements, survives.
	 */
	private text(node: XmlNode, parent: string): string | null {
		let value: string;
		if (
			typeof node[TEXT_KEY] === "string" &&
			Object.keys(node).length === 1
		) {
			value = decodeXml(node[TEXT_KEY]);
		} else if (CDATA_KEY in node) {
			value = readCdata(node) ?? "";
		} else {
			return null;
		}
		value = stripControlCharacters(value);
		if (TEXT_ELEMENTS.has(parent) || value.trim() === "") {
			return escapeText(value);
		}
		return "";
	}

	/** A `<style>` element's text, decoded, with nested elements ignored. */
	private textContent(nodes: readonly unknown[]): string {
		let out = "";
		for (const node of nodes) {
			if (!isRecord(node)) {
				continue;
			}
			if (typeof node[TEXT_KEY] === "string") {
				out += decodeXml(node[TEXT_KEY]);
			} else if (CDATA_KEY in node) {
				out += readCdata(node) ?? "";
			}
		}
		return out;
	}

	private attributes(attributes: Record<string, string>): [string, string][] {
		const kept: [string, string][] = [];
		const seen = new Set<string>();
		const keep = (name: string, value: string | null) => {
			if (value !== null && !seen.has(name)) {
				seen.add(name);
				kept.push([name, value]);
			}
		};
		for (const [name, value] of Object.entries(attributes)) {
			if (name === "id") {
				keep(
					"id",
					ID_PATTERN.test(value) ? `${this.scopeId}-${value}` : null,
				);
			} else if (name === "class") {
				keep("class", cleanClassList(value));
			} else if (name === "href" || name === "xlink:href") {
				// Only a same-document reference, written as SVG 2 `href` so no
				// `xlink` namespace declaration is needed.
				const match = /^#([A-Za-z0-9_.-]{1,200})$/.exec(value.trim());
				keep("href", match ? `#${this.scopeId}-${match[1]}` : null);
			} else if (name === "font-family") {
				keep(name, safeFontFamilyList(value));
			} else if (VALUE_ATTRIBUTES.has(name)) {
				keep(name, safeValue(value, this.scopeId));
			}
		}
		return kept;
	}
}

/** Class names that are plain identifiers, each with the diagram prefix. */
function cleanClassList(value: string): string | null {
	const classes = value
		.split(/\s+/)
		.filter((name) => CLASS_PATTERN.test(name))
		.map((name) => `${DIAGRAM_CLASS_PREFIX}${name}`);
	return classes.length > 0 ? classes.join(" ") : null;
}

/**
 * A colour, number, path, transform or reference value with every `url(#id)`
 * scoped, or null when it holds anything else: a quote, a backslash, markup
 * characters, a function outside {@link ALLOWED_FUNCTIONS}, or a `url()` that
 * is not a same-document `#id`.
 */
function safeValue(value: string, scopeId: string): string | null {
	const trimmed = value.trim();
	if (
		trimmed === "" ||
		trimmed.length > 100_000 ||
		!SAFE_VALUE.test(trimmed)
	) {
		return null;
	}
	const lowered = trimmed.toLowerCase();
	if (lowered.includes("expression") || lowered.includes("javascript")) {
		return null;
	}
	for (const match of trimmed.matchAll(/([A-Za-z_-][A-Za-z0-9_-]*)\(/g)) {
		if (!ALLOWED_FUNCTIONS.has((match[1] ?? "").toLowerCase())) {
			return null;
		}
	}
	let refused = false;
	const scoped = trimmed.replace(/url\(([^()]*)\)/gi, (_, inner: string) => {
		const id = /^\s*#([A-Za-z0-9_.-]{1,200})\s*$/.exec(inner)?.[1];
		if (id === undefined) {
			refused = true;
			return "";
		}
		return `url(#${scopeId}-${id})`;
	});
	// Any `url(` left over was not a closed, plain `url(#id)`.
	const leftover = scoped.replace(/url\(#[A-Za-z0-9_.-]+\)/g, "");
	if (refused || /url\(/i.test(leftover)) {
		return null;
	}
	return scoped;
}

/**
 * A font-family list of plain family names: generic families stay keywords,
 * every other name is quoted, and a name with anything but letters, digits,
 * spaces and hyphens is dropped.
 */
function safeFontFamilyList(value: string): string | null {
	const families: string[] = [];
	for (const part of value.split(",")) {
		const trimmed = part.trim();
		const quoted = /^(['"])(.*)\1$/.exec(trimmed);
		const name = (quoted ? (quoted[2] ?? "") : trimmed)
			.trim()
			.replace(/\s+/g, " ");
		if (!FAMILY_NAME.test(name)) {
			continue;
		}
		families.push(
			!quoted && GENERIC_FAMILIES.has(name.toLowerCase())
				? name.toLowerCase()
				: `"${name}"`,
		);
	}
	return families.length > 0 ? families.join(", ") : null;
}

/**
 * The root's `style`: custom-property declarations only, which is where
 * beautiful-mermaid puts its seven colours, plus a `background` that is
 * exactly `var(--bg)`.
 */
function cleanRootStyle(style: string, scopeId: string): string {
	const kept: string[] = [];
	for (const declaration of splitTopLevel(stripComments(style), ";")) {
		const parsed = readDeclaration(declaration);
		if (!parsed) {
			continue;
		}
		if (parsed.property.startsWith("--")) {
			const value = safeValue(parsed.value, scopeId);
			if (value !== null) {
				kept.push(`${parsed.property}:${value}`);
			}
		} else if (
			parsed.property === "background" &&
			parsed.value.replace(/\s+/g, "") === "var(--bg)"
		) {
			kept.push("background:var(--bg)");
		}
	}
	return kept.join(";");
}

/**
 * A stylesheet re-tokenized into scoped rules. Every at-rule (`@import`,
 * `@font-face`, `@media` …) is dropped with its block, nested rules are
 * dropped, selectors outside plain type, class and descendant selectors are
 * dropped, and the remaining selectors are scoped under the diagram's root:
 * `svg` becomes `#scope`, anything else `#scope <selector>`. Declarations
 * keep custom properties and {@link CSS_PROPERTIES} whose values pass
 * {@link safeValue} (`font-family` passes {@link safeFontFamilyList}).
 */
function cleanStylesheet(css: string, scopeId: string): string[] {
	const text = stripComments(css);
	const rules: string[] = [];
	let index = 0;
	while (index < text.length) {
		while (index < text.length && /\s/.test(text[index] ?? "")) {
			index++;
		}
		if (index >= text.length) {
			break;
		}
		if (text[index] === "@") {
			index = skipAtRule(text, index);
			continue;
		}
		const open = scanTo(text, index, "{;}");
		if (open === -1) {
			break;
		}
		if (text[open] !== "{") {
			// A stray `;` or `}` outside any rule: skip past it.
			index = open + 1;
			continue;
		}
		const close = matchingBrace(text, open);
		if (close === -1) {
			break;
		}
		const prelude = text.slice(index, open);
		const block = text.slice(open + 1, close);
		index = close + 1;
		if (scanTo(block, 0, "{") !== -1) {
			continue;
		}
		const selector = scopeSelectorList(prelude, scopeId);
		const declarations = cleanDeclarations(block, scopeId);
		if (selector && declarations.length > 0) {
			rules.push(`${selector} { ${declarations.join("; ")}; }`);
		}
	}
	return rules;
}

function cleanDeclarations(block: string, scopeId: string): string[] {
	const kept: string[] = [];
	for (const declaration of splitTopLevel(block, ";")) {
		const parsed = readDeclaration(declaration);
		if (!parsed) {
			continue;
		}
		const { property, value } = parsed;
		let cleaned: string | null = null;
		if (property === "font-family") {
			cleaned = safeFontFamilyList(value);
		} else if (property.startsWith("--") || CSS_PROPERTIES.has(property)) {
			cleaned = safeValue(value, scopeId);
		}
		if (cleaned !== null) {
			kept.push(`${property}: ${cleaned}`);
		}
	}
	return kept;
}

/**
 * `property: value`, with a custom property's name kept as written (they are
 * case-sensitive) and any other lowercased; null when the name is not a
 * plain identifier.
 */
function readDeclaration(
	declaration: string,
): { property: string; value: string } | null {
	const colon = declaration.indexOf(":");
	if (colon === -1) {
		return null;
	}
	const name = declaration.slice(0, colon).trim();
	const value = declaration.slice(colon + 1).trim();
	if (/^--[A-Za-z0-9_-]{1,100}$/.test(name)) {
		return { property: name, value };
	}
	if (/^[A-Za-z-]{1,100}$/.test(name)) {
		return { property: name.toLowerCase(), value };
	}
	return null;
}

/** A selector list scoped under `#scopeId`, or null when none survives. */
function scopeSelectorList(prelude: string, scopeId: string): string | null {
	const scoped: string[] = [];
	for (const selector of prelude.split(",")) {
		const compounds = selector.trim().split(/\s+/);
		if (
			compounds.length === 0 ||
			compounds.some((compound) => !isPlainCompound(compound))
		) {
			continue;
		}
		const prefixed = compounds.map((compound) =>
			compound.replace(
				/\.([A-Za-z0-9_-]+)/g,
				(_, name: string) => `.${DIAGRAM_CLASS_PREFIX}${name}`,
			),
		);
		const first = prefixed[0] ?? "";
		if (first === "svg" || first.startsWith("svg.")) {
			prefixed[0] = `#${scopeId}${first.slice(3)}`;
			scoped.push(prefixed.join(" "));
		} else {
			scoped.push(`#${scopeId} ${prefixed.join(" ")}`);
		}
	}
	return scoped.length > 0 ? scoped.join(", ") : null;
}

/** A type selector, class selectors, or both: `text`, `.mono`, `path.a.b`. */
function isPlainCompound(compound: string): boolean {
	return (
		/^(?:[A-Za-z][A-Za-z0-9-]*)?(?:\.[A-Za-z_-][A-Za-z0-9_-]*)*$/.test(
			compound,
		) && compound !== ""
	);
}

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
}

/**
 * The index of the first of `stops` at nesting depth zero from `from`,
 * outside strings and parentheses, or -1.
 */
function scanTo(text: string, from: number, stops: string): number {
	let depth = 0;
	for (let index = from; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char === '"' || char === "'") {
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
		if (char === '"' || char === "'") {
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

/**
 * The size from the viewBox, or from plain pixel `width` and `height` when
 * there is none; null when neither gives two positive edges of at most
 * {@link MAX_DIAGRAM_EDGE}.
 */
function readSize(
	attributes: Record<string, string>,
): { viewBox: string; width: number; height: number } | null {
	const viewBox = attributes.viewBox?.trim();
	if (viewBox !== undefined) {
		const parts = viewBox.split(/[\s,]+/).map(Number);
		if (parts.length !== 4 || !parts.every(Number.isFinite)) {
			return null;
		}
		const [minX = 0, minY = 0, width = 0, height = 0] = parts;
		if (!usableEdge(width) || !usableEdge(height)) {
			return null;
		}
		if (
			Math.abs(minX) > MAX_DIAGRAM_EDGE ||
			Math.abs(minY) > MAX_DIAGRAM_EDGE
		) {
			return null;
		}
		return {
			viewBox: [minX, minY, width, height].map(formatNumber).join(" "),
			width,
			height,
		};
	}
	const width = readPixels(attributes.width);
	const height = readPixels(attributes.height);
	if (width === null || height === null) {
		return null;
	}
	return {
		viewBox: `0 0 ${formatNumber(width)} ${formatNumber(height)}`,
		width,
		height,
	};
}

function usableEdge(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= MAX_DIAGRAM_EDGE;
}

function readPixels(value: string | undefined): number | null {
	const match = /^\s*(\d{1,6}(?:\.\d{1,10})?)(?:px)?\s*$/.exec(value ?? "");
	const pixels = match ? Number(match[1]) : Number.NaN;
	return usableEdge(pixels) ? pixels : null;
}

function formatNumber(value: number): string {
	return String(Object.is(value, -0) ? 0 : value);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/**
 * The five predefined XML entities and numeric references, decoded once.
 * Any other `&name;` stays literal text (its `&` is escaped on the way out),
 * so an entity a DOCTYPE declares never expands, and what decoding yields is
 * always re-escaped: it can never become markup.
 */
function decodeXml(raw: string): string {
	return raw.replace(
		/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/g,
		(_, hex: string | undefined, decimal: string | undefined, name) => {
			if (name !== undefined) {
				return NAMED_ENTITIES[name as string] ?? "";
			}
			const code =
				hex !== undefined
					? Number.parseInt(hex, 16)
					: Number.parseInt(decimal ?? "", 10);
			if (
				!Number.isFinite(code) ||
				code === 0 ||
				code > 0x10ffff ||
				(code >= 0xd800 && code <= 0xdfff)
			) {
				return "�";
			}
			return String.fromCodePoint(code);
		},
	);
}

/** C0 controls other than tab, line feed and carriage return. */
function stripControlCharacters(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function escapeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(stripControlCharacters(value)).replace(/"/g, "&quot;");
}

function serializeAttributes(attributes: readonly [string, string][]): string {
	return attributes
		.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
		.join("");
}
