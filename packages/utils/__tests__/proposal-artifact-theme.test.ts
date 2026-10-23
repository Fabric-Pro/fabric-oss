import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../lib/brand-colors";
import {
	PROPOSAL_PAGE_SIZE,
	PROPOSAL_PAGE_SIZE_LANDSCAPE,
	PROPOSAL_PRINT_CLASSES,
	PROPOSAL_THEME_ATTRIBUTE,
	PROPOSAL_THEME_CLASSES,
	PROPOSAL_THEME_ROOT_SELECTORS,
	type ProposalPrintThemeOptions,
	proposalThemeCss,
} from "../lib/proposal-artifact/proposal-theme";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
	TEXT_CONTRAST,
} from "../lib/proposal-artifact/theme-tokens";

// --- A small CSS reader, enough for the stylesheet this module emits. ---

interface CssBlock {
	/** The preludes of the blocks this one sits in, outermost first. */
	path: string[];
	prelude: string;
	declarations: [property: string, value: string][];
}

function parseCss(css: string): CssBlock[] {
	const blocks: CssBlock[] = [];
	let index = 0;

	const readString = (quote: string): string => {
		let text = quote;
		while (index < css.length) {
			const character = css[index++] as string;
			text += character;
			if (character === "\\") {
				text += css[index++] ?? "";
			} else if (character === quote) {
				break;
			}
		}
		return text;
	};

	const readBlock = (path: string[]): [string, string][] => {
		const declarations: [string, string][] = [];
		let buffer = "";
		const flush = () => {
			const text = buffer.trim();
			buffer = "";
			if (text) {
				const colon = text.indexOf(":");
				declarations.push([
					text.slice(0, colon).trim(),
					text.slice(colon + 1).trim(),
				]);
			}
		};
		while (index < css.length) {
			const character = css[index++] as string;
			if (character === '"' || character === "'") {
				buffer += readString(character);
			} else if (character === "{") {
				const prelude = buffer.trim();
				buffer = "";
				const inner = readBlock([...path, prelude]);
				blocks.push({ path, prelude, declarations: inner });
			} else if (character === "}") {
				flush();
				return declarations;
			} else if (character === ";") {
				flush();
			} else {
				buffer += character;
			}
		}
		flush();
		return declarations;
	};

	readBlock([]);
	return blocks;
}

/** Split on commas that are not inside brackets, parentheses or strings. */
function splitTopLevel(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let current = "";
	for (const character of list) {
		if (quote) {
			if (character === quote) {
				quote = null;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "(" || character === "[") {
			depth++;
		} else if (character === ")" || character === "]") {
			depth--;
		} else if (character === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	if (current.trim()) {
		parts.push(current.trim());
	}
	return parts;
}

function styleRules(css: string): CssBlock[] {
	return parseCss(css).filter((block) => !block.prelude.startsWith("@"));
}

function selectorsOf(block: CssBlock): string[] {
	return splitTopLevel(block.prelude);
}

/** The merged declarations of every top-level rule with exactly this selector. */
function declarationsFor(
	css: string,
	selector: string,
	path: string[] = [],
): Map<string, string> {
	const merged = new Map<string, string>();
	for (const block of styleRules(css)) {
		if (
			block.path.join("|") === path.join("|") &&
			selectorsOf(block).includes(selector)
		) {
			for (const [property, value] of block.declarations) {
				merged.set(property, value);
			}
		}
	}
	return merged;
}

function atBlock(css: string, prelude: string): CssBlock {
	const found = parseCss(css).find((block) => block.prelude === prelude);
	if (!found) {
		throw new Error(`no ${prelude} block`);
	}
	return found;
}

/** Decode a double-quoted CSS string the way a browser does. */
function decodeCssString(literal: string): string {
	expect(literal.startsWith('"') && literal.endsWith('"')).toBe(true);
	return literal
		.slice(1, -1)
		.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_match, hex, character) =>
			hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : character,
		);
}

// --- Selector specificity, (ids, classes/attributes/pseudo-classes, types). ---

type Specificity = [number, number, number];

const LEGACY_PSEUDO_ELEMENTS = new Set([
	"before",
	"after",
	"first-line",
	"first-letter",
]);

function compareSpecificity(left: Specificity, right: Specificity): number {
	for (let i = 0; i < 3; i++) {
		const difference = (left[i] as number) - (right[i] as number);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

function maxSpecificity(list: string): Specificity {
	return splitTopLevel(list)
		.map(specificity)
		.reduce<Specificity>(
			(max, next) => (compareSpecificity(next, max) > 0 ? next : max),
			[0, 0, 0],
		);
}

function specificity(selector: string): Specificity {
	const result: Specificity = [0, 0, 0];
	const add = (other: Specificity) => {
		result[0] += other[0];
		result[1] += other[1];
		result[2] += other[2];
	};
	const identifierEnd = (from: number) => {
		let end = from;
		while (end < selector.length) {
			if (selector[end] === "\\") {
				end += 2;
			} else if (/[\w-]/.test(selector[end] as string)) {
				end++;
			} else {
				break;
			}
		}
		return end;
	};
	const closing = (from: number, open: string, close: string) => {
		let depth = 0;
		let quote: string | null = null;
		for (let end = from; end < selector.length; end++) {
			const character = selector[end];
			if (quote) {
				if (character === quote) {
					quote = null;
				}
			} else if (character === '"' || character === "'") {
				quote = character;
			} else if (character === open) {
				depth++;
			} else if (character === close && --depth === 0) {
				return end;
			}
		}
		throw new Error(`unbalanced ${open} in ${selector}`);
	};

	let index = 0;
	while (index < selector.length) {
		const character = selector[index] as string;
		if (character === "#") {
			result[0]++;
			index = identifierEnd(index + 1);
		} else if (character === ".") {
			result[1]++;
			index = identifierEnd(index + 1);
		} else if (character === "[") {
			result[1]++;
			index = closing(index, "[", "]") + 1;
		} else if (character === ":") {
			const element = selector[index + 1] === ":";
			const start = index + (element ? 2 : 1);
			const end = identifierEnd(start);
			const name = selector.slice(start, end).toLowerCase();
			let argument = "";
			index = end;
			if (selector[end] === "(") {
				const close = closing(end, "(", ")");
				argument = selector.slice(end + 1, close);
				index = close + 1;
			}
			if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) {
				result[2]++;
			} else if (name === "where") {
				// Zero by definition.
			} else if (name === "is" || name === "not" || name === "has") {
				add(maxSpecificity(argument));
			} else if (
				(name === "nth-child" || name === "nth-last-child") &&
				/\sof\s/.test(argument)
			) {
				result[1]++;
				add(maxSpecificity(argument.split(/\sof\s/)[1] as string));
			} else {
				result[1]++;
			}
		} else if (/[a-zA-Z]/.test(character)) {
			result[2]++;
			index = identifierEnd(index);
		} else {
			index++;
		}
	}
	return result;
}

// --- Fixtures ---

const LIVE_ROOT = PROPOSAL_THEME_ROOT_SELECTORS.live;
const PRINT_ROOT = PROPOSAL_THEME_ROOT_SELECTORS.print;
const NARROW = "@media (width < 48rem)";

const PRINT_OPTIONS: ProposalPrintThemeOptions = {
	runningHeader: "Example Proposal",
	runningFooter:
		"Example Org · Example Proposal · 14 October 2026 · Confidential",
};

const live = proposalThemeCss("live");
const print = proposalThemeCss("print", PRINT_OPTIONS);

/** The most the app's own editor rules reach: `.dark .tiptap code`. */
const GLOBAL_EDITOR_SPECIFICITY: Specificity = [0, 2, 1];

/** Every `var(--name` the stylesheet references, with its declaration. */
function variableReferences(
	css: string,
): { name: string; property: string; value: string }[] {
	const references: { name: string; property: string; value: string }[] = [];
	for (const block of parseCss(css)) {
		for (const [property, value] of block.declarations) {
			for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
				references.push({ name: match[1] as string, property, value });
			}
		}
	}
	return references;
}

describe("the specificity counter used below", () => {
	it("scores the selectors the theme has to beat", () => {
		expect(specificity(".dark .tiptap code")).toEqual([0, 2, 1]);
		expect(specificity(".tiptap figure.image-figure img")).toEqual([
			0, 2, 2,
		]);
		expect(
			specificity(
				'.prose :where(h2):not(:where([class~="not-prose"],[class~="not-prose"] *))',
			),
		).toEqual([0, 1, 0]);
		expect(specificity("#a .b c::before")).toEqual([1, 1, 2]);
		expect(specificity("li:nth-child(2n of .x)")).toEqual([0, 2, 1]);
		expect(specificity(".a:is(.b, #c) > d")).toEqual([1, 1, 1]);
		expect(specificity(".dark\\:prose-invert")).toEqual([0, 1, 0]);
		expect(specificity(LIVE_ROOT)).toEqual([0, 3, 0]);
	});
});

describe("proposalThemeCss: both targets", () => {
	it.each([
		["live", live],
		["print", print],
	])("%s never names editor internals or loads anything", (_target, css) => {
		for (const forbidden of [
			".tiptap",
			".ProseMirror",
			"mermaid",
			"node-view",
			"react-renderer",
			"[data-node-view",
			".dark",
			"prefers-color-scheme",
			"url(",
			"@import",
			"http",
			"expression(",
			"javascript:",
			"!important",
		]) {
			expect(css).not.toContain(forbidden);
		}
	});

	it.each([
		["live", live],
		["print", print],
	])("%s writes no literal colour", (_target, css) => {
		expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/);
		const colourProperty =
			/^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|text-decoration-color|box-shadow|fill|stroke)$/;
		const named =
			/\b(white|black|red|green|blue|gray|grey|silver|navy|yellow|orange|purple)\b/;
		for (const block of parseCss(css)) {
			for (const [property, value] of block.declarations) {
				if (colourProperty.test(property)) {
					expect({ property, value }).not.toEqual({
						property,
						value: expect.stringMatching(named),
					});
				}
			}
		}
	});

	it.each([
		["live", live],
		["print", print],
	])(
		"%s reads only theme tokens, and the app's fonts as fallbacks",
		(_target, css) => {
			for (const reference of variableReferences(css)) {
				if (reference.name.startsWith("--pa-")) {
					continue;
				}
				expect(reference).toEqual({
					name: expect.stringMatching(/^--font-(inter|mono)$/),
					property: "font-family",
					value: reference.value,
				});
			}
		},
	);

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])("%s scopes every rule under its root", (_target, css, root) => {
		for (const block of styleRules(css)) {
			if (block.path.some((prelude) => prelude.startsWith("@page"))) {
				continue;
			}
			for (const selector of selectorsOf(block)) {
				const scoped =
					selector === root ||
					selector.startsWith(`${root} `) ||
					selector === `html:has(> ${root})`;
				expect({ selector, scoped }).toEqual({
					selector,
					scoped: true,
				});
			}
		}
	});

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])(
		"%s turns Inter's contextual alternates off on the root",
		(_target, css, root) => {
			expect(
				declarationsFor(css, root).get("font-variant-ligatures"),
			).toBe("no-contextual");
		},
	);

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])(
		"%s sets the body in the brand font with Inter behind it",
		(_target, css, root) => {
			expect(declarationsFor(css, root).get("font-family")).toBe(
				'var(--pa-font-body, "Inter"), var(--font-inter, "Inter"), ui-sans-serif, system-ui, sans-serif',
			);
			expect(
				declarationsFor(css, `${root} h2`).get("font-family"),
			).toMatch(/^var\(--pa-font-display, "Inter"\)/);
			expect(
				declarationsFor(css, `${root} pre`).get("font-family"),
			).toMatch(/^ui-monospace, var\(--font-mono, [^)]+\).*monospace$/);
			expect(
				declarationsFor(css, `${root} th`).get("font-family"),
			).toMatch(/^var\(--pa-font-mono, "Inter"\)/);
		},
	);

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])(
		"%s maps the markdown forms onto the semantic classes",
		(_target, css, root) => {
			const lead = styleRules(css).find((block) =>
				selectorsOf(block).includes(`${root} h1 + p`),
			);
			expect(lead && selectorsOf(lead)).toContain(`${root} .pa-lead`);

			const callout = declarationsFor(css, `${root} blockquote`);
			expect(declarationsFor(css, `${root} .pa-callout`)).toEqual(
				callout,
			);
			expect(callout.get("background-color")).toBe("var(--pa-tint)");
			expect(callout.get("border-left")).toBe(
				"4px solid var(--pa-primary)",
			);
			expect(callout.get("font-style")).toBe("normal");
			// The typography plugin wraps a blockquote in curly quotes.
			expect(callout.get("quotes")).toBe("none");

			// An unmarked table: one a pending AI change marks keeps the
			// editor's review frame instead of the paper's.
			const table = new Map([
				...declarationsFor(css, `${root} table`),
				...declarationsFor(css, `${root} table:not([data-diff])`),
			]);
			expect(declarationsFor(css, `${root} .pa-data-table`)).toEqual(
				table,
			);
			const header = declarationsFor(css, `${root} th`);
			expect(header.get("background-color")).toBe("var(--pa-primary)");
			expect(header.get("color")).toBe("var(--pa-on-primary)");
			expect(header.get("text-transform")).toBe("uppercase");
			expect(
				declarationsFor(
					css,
					`${root} tbody > tr:nth-child(even) > td`,
				).get("background-color"),
			).toBe("var(--pa-tint)");

			expect(declarationsFor(css, `${root} figcaption`)).toEqual(
				declarationsFor(css, `${root} .pa-caption`),
			);
			expect(declarationsFor(css, `${root} figure`)).toEqual(
				declarationsFor(css, `${root} .pa-figure`),
			);
		},
	);

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])(
		"%s keeps a link in a header cell in the cell's own text colour",
		(_target, css, root) => {
			expect(declarationsFor(css, `${root} th a`).get("color")).toBe(
				"inherit",
			);
		},
	);

	it("keeps a link on the print section opener in the band's text colour", () => {
		expect(
			declarationsFor(print, `${PRINT_ROOT} .pa-section-opener a`).get(
				"color",
			),
		).toBe("inherit");
	});

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])(
		"%s shows a tile's value above its label, one to four across",
		(_target, css, root) => {
			const tiles = declarationsFor(css, `${root} .pa-stat-tiles`);
			expect(tiles.get("display")).toBe("grid");
			expect(tiles.get("grid-template-columns")).toBe(
				"repeat(auto-fit, minmax(9rem, 1fr))",
			);
			const tile = declarationsFor(css, `${root} .pa-stat-tile`);
			// The DOM is <dt>label</dt><dd>value</dd>; the value reads first.
			expect(tile.get("display")).toBe("flex");
			expect(tile.get("flex-direction")).toBe("column-reverse");
			expect(tile.get("border-top")).toBe("3px solid var(--pa-primary)");
			for (const part of [".pa-stat-value", ".pa-stat-label"]) {
				const declarations = declarationsFor(css, `${root} ${part}`);
				expect(declarations.get("margin")).toBe("0");
				expect(declarations.get("padding")).toBe("0");
			}
		},
	);

	it.each([
		["live", live, LIVE_ROOT],
		["print", print, PRINT_ROOT],
	])(
		"%s sets every property the editor's global rules set on the elements it styles",
		(_target, css, root) => {
			// From the global `.tiptap` and `.dark .tiptap` rules in the editor
			// stylesheet. A property left out would show the app's colour mode
			// through the paper.
			const globalRules: Record<string, string[]> = {
				code: [
					"background-color",
					"border-radius",
					"color",
					"font-size",
					"padding",
				],
				pre: [
					"background-color",
					"border-radius",
					"color",
					"font-family",
					"margin",
					"padding",
				],
				"pre code": [
					"background-color",
					"color",
					"font-size",
					"padding",
				],
				blockquote: ["border-left", "margin", "padding"],
				hr: ["border", "border-top", "margin"],
				table: [
					"border-collapse",
					"margin",
					"width",
					"border-radius",
					"border",
				],
				th: [
					"border",
					"padding",
					"vertical-align",
					"background-color",
					"font-weight",
					"text-align",
				],
				td: ["border", "padding", "vertical-align"],
				"ul, ol": ["padding", "margin"],
				"h1, h2, h3, h4, h5, h6": [
					"line-height",
					"margin-top",
					"margin-bottom",
					"text-wrap",
					"font-weight",
					"font-family",
				],
				p: ["margin-bottom"],
				"li p": ["margin-block"],
			};
			for (const [elements, properties] of Object.entries(globalRules)) {
				for (const element of elements.split(", ")) {
					const declared = new Map([
						...declarationsFor(css, `${root} ${element}`),
						// The paper's frame goes on an unmarked table only.
						...(element === "table"
							? declarationsFor(
									css,
									`${root} table:not([data-diff])`,
								)
							: []),
					]);
					for (const property of properties) {
						expect({
							element,
							property,
							set: declared.has(property),
						}).toEqual({
							element,
							property,
							set: true,
						});
					}
				}
			}
		},
	);
});

describe("proposalThemeCss: live", () => {
	it("leaves a table marked by a pending AI change in the editor's review frame", () => {
		const every = declarationsFor(live, `${LIVE_ROOT} table`);
		expect(every.has("border")).toBe(false);
		expect(every.has("background-color")).toBe(false);

		const unmarked = declarationsFor(
			live,
			`${LIVE_ROOT} table:not([data-diff])`,
		);
		expect(unmarked.get("border")).toBe("1px solid var(--pa-border)");
		expect(unmarked.get("background-color")).toBe("var(--pa-surface)");
	});

	it("gives text a pending AI change marks an opaque wash on the paper", () => {
		for (const [mark, wash] of [
			["ins", "var(--pa-review-insert)"],
			["del", "var(--pa-review-delete)"],
		]) {
			const selector = `${LIVE_ROOT} ${mark}:not([hidden])`;
			expect(
				declarationsFor(live, selector).get("background-color"),
			).toBe(wash);
			expect(
				compareSpecificity(specificity(selector), [0, 3, 1]),
			).toBeGreaterThan(0);
		}
	});

	it("paints text a pending AI change marks in the paper's ink, above the dark mode review rules", () => {
		const selector = `${LIVE_ROOT} :is(ins, del):not([hidden])`;
		expect(declarationsFor(live, selector).get("color")).toBe(
			"var(--pa-ink)",
		);
		// `.dark .streaming-diff-active .tiptap ins` is three classes and an element.
		expect(
			compareSpecificity(specificity(selector), [0, 3, 1]),
		).toBeGreaterThan(0);
	});

	it("targets the Main wrapper by class and attribute", () => {
		expect(LIVE_ROOT).toBe(
			`.${PROPOSAL_THEME_CLASSES.root}.${PROPOSAL_THEME_CLASSES.root}[${PROPOSAL_THEME_ATTRIBUTE}="live"]`,
		);
	});

	it("outranks the editor's global rules with every rule", () => {
		const rules = styleRules(live);
		expect(rules.length).toBeGreaterThan(40);
		for (const block of rules) {
			for (const selector of selectorsOf(block)) {
				const score = specificity(selector);
				expect({
					selector,
					outranks:
						compareSpecificity(score, GLOBAL_EDITOR_SPECIFICITY) >
						0,
				}).toEqual({ selector, outranks: true });
			}
		}
	});

	it("paints the paper from the theme tokens, not from the names it remaps", () => {
		const root = declarationsFor(live, LIVE_ROOT);

		expect(root.get("background-color")).toBe("var(--pa-surface)");
		expect(root.get("color")).toBe("var(--pa-ink)");
		expect(root.get("color-scheme")).toBe("light");
		for (const [property, value] of root) {
			if (property.startsWith("--")) {
				continue;
			}
			expect({ property, value }).not.toEqual({
				property,
				value: expect.stringMatching(
					/var\(--(color-|background|foreground|card|muted|primary|border)/,
				),
			});
		}
	});

	it("remaps the app's colour tokens onto the paper under both names", () => {
		const root = declarationsFor(live, LIVE_ROOT);
		const themeCss = readFileSync(
			fileURLToPath(
				new URL("../../../tooling/tailwind/theme.css", import.meta.url),
			),
			"utf8",
		);
		const appTokens = [
			"background",
			"foreground",
			"card",
			"card-foreground",
			"popover",
			"popover-foreground",
			"primary",
			"primary-foreground",
			"primary-ink",
			"secondary",
			"secondary-foreground",
			"muted",
			"muted-foreground",
			"accent",
			"accent-foreground",
			"border",
			"input",
			"ring",
		];

		for (const token of appTokens) {
			// The token exists in the app theme under these exact names…
			expect(themeCss).toContain(`--color-${token}: var(--${token});`);
			// …and the paper sets both, from theme tokens only.
			for (const name of [`--${token}`, `--color-${token}`]) {
				expect({ name, value: root.get(name) }).toEqual({
					name,
					value: expect.stringMatching(/var\(--pa-/),
				});
			}
		}
		expect(root.get("--background")).toBe("var(--pa-surface)");
		expect(root.get("--foreground")).toBe("var(--pa-ink)");
		expect(root.get("--card")).toBe("var(--pa-surface)");
		expect(root.get("--muted-foreground")).toBe("var(--pa-muted)");
	});

	it("remaps the typography plugin's tokens too", () => {
		const root = declarationsFor(live, LIVE_ROOT);

		for (const token of [
			"background",
			"foreground",
			"muted",
			"muted-foreground",
			"popover",
			"popover-foreground",
			"card",
			"card-foreground",
			"border",
			"primary",
			"primary-foreground",
			"secondary",
			"secondary-foreground",
			"accent",
			"accent-foreground",
			"ring",
		]) {
			expect(root.get(`--color-fd-${token}`)).toMatch(/var\(--pa-/);
		}
		const bridge = declarationsFor(live, `${LIVE_ROOT} .prose`);
		expect(bridge.get("font-size")).toBe("inherit");
		expect(bridge.get("line-height")).toBe("inherit");
		expect(bridge.get("color")).toBe("inherit");
	});

	it("keeps a readable column on wide screens", () => {
		const root = declarationsFor(live, LIVE_ROOT);

		expect(root.get("max-width")).toBe("calc(72ch + 6rem)");
		// Centred, with room above and below the sheet; the editor inside
		// supplies the text inset, so the paper's own padding stays thin.
		expect(root.get("margin")).toBe("1.5rem auto");
		expect(root.get("padding")).toBe("0.5rem");
		expect(root.get("font-size")).toBe("1.0625rem");
	});

	it("takes the full width at the editor's base size below 48rem", () => {
		const root = declarationsFor(live, LIVE_ROOT, [NARROW]);
		expect(root.get("max-width")).toBe("none");
		expect(root.get("margin")).toBe("0");
		expect(root.get("padding")).toBe("0");
		expect(root.get("font-size")).toBe("1rem");

		expect(
			declarationsFor(live, `${LIVE_ROOT} .pa-stat-tiles`, [NARROW]).get(
				"grid-template-columns",
			),
		).toBe("repeat(2, minmax(0, 1fr))");

		const table = declarationsFor(live, `${LIVE_ROOT} table`, [NARROW]);
		expect(table.get("display")).toBe("block");
		expect(table.get("max-width")).toBe("100%");
		expect(table.get("overflow-x")).toBe("auto");
	});

	it("leaves the print-only layer out", () => {
		expect(live).not.toContain("@page");
		expect(live).not.toContain(".pa-cover");
		expect(live).not.toContain(".pa-section-opener");
		expect(live).not.toContain("print-color-adjust");
	});

	it("reads the same in both app colour modes", () => {
		// The cascade cannot be computed here, so this pins the structure: no
		// rule depends on the app's colour mode, and the paper's own ink and
		// surface are a readable pair.
		expect(live).not.toMatch(
			/\.dark\b|prefers-color-scheme|:root\b|html\b/,
		);
		const paint = resolveThemePaint(
			buildProposalThemeTokens({
				organization: null,
				style: null,
				brandKit: null,
				recipient: null,
			}),
		);
		expect(contrastRatio(paint.ink, paint.surface)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
	});
});

describe("proposalThemeCss: print", () => {
	it("targets the print body", () => {
		expect(PRINT_ROOT).toBe('body[data-proposal-theme="print"]');
	});

	it("prints on US Letter, set once", () => {
		expect(PROPOSAL_PAGE_SIZE).toBe("letter");
		const page = new Map(atBlock(print, "@page").declarations);

		expect(page.get("size")).toBe(PROPOSAL_PAGE_SIZE);
		// The default page and the landscape page; nothing else sets a size.
		expect(print.match(/(?<![\w-])size:/g)).toHaveLength(2);
	});

	it("puts the running header, footer and page counter in margin boxes", () => {
		const boxes = parseCss(print).filter(
			(block) => block.path.join("|") === "@page",
		);
		const content = (box: string) =>
			new Map(
				boxes.find((block) => block.prelude === box)?.declarations,
			).get("content");

		expect(decodeCssString(content("@top-left") as string)).toBe(
			PRINT_OPTIONS.runningHeader,
		);
		expect(decodeCssString(content("@bottom-left") as string)).toBe(
			PRINT_OPTIONS.runningFooter,
		);
		expect(content("@bottom-right")).toBe(
			'"Page " counter(page) " of " counter(pages)',
		);
	});

	it("sets the margin boxes in a literal font with contextual alternates off", () => {
		const boxes = parseCss(print).filter(
			(block) => block.path.join("|") === "@page",
		);
		expect(boxes.map((block) => block.prelude)).toEqual([
			"@top-left",
			"@bottom-left",
			"@bottom-right",
		]);
		for (const box of boxes) {
			const declarations = new Map(box.declarations);
			expect(declarations.get("font-family")).toBe(
				'"Inter", ui-sans-serif, sans-serif',
			);
			expect(declarations.get("font-variant-ligatures")).toBe(
				"no-contextual",
			);
		}
		// Margin boxes inherit from the root element, not from the body.
		const html = declarationsFor(print, `html:has(> ${PRINT_ROOT})`);
		expect(html.get("font-family")).toBe(
			'"Inter", ui-sans-serif, sans-serif',
		);
		expect(html.get("font-variant-ligatures")).toBe("no-contextual");
	});

	it("puts a brand family ahead of Inter in the margin boxes, and refuses a hostile one", () => {
		const branded = proposalThemeCss("print", {
			...PRINT_OPTIONS,
			fontFamily: "Example Sans",
		});
		const hostile = proposalThemeCss("print", {
			...PRINT_OPTIONS,
			fontFamily: 'Inter"; } body { x',
		});

		expect(
			new Map(atBlock(branded, "@top-left").declarations).get(
				"font-family",
			),
		).toBe('"Example Sans", "Inter", ui-sans-serif, sans-serif');
		expect(
			new Map(atBlock(hostile, "@top-left").declarations).get(
				"font-family",
			),
		).toBe('"Inter", ui-sans-serif, sans-serif');
		expect(hostile).not.toContain("body { x");
	});

	it("counts the cover as page 1 and shows it no furniture", () => {
		expect(print).not.toMatch(/counter-(reset|increment|set):\s*page\b/);

		const cover = parseCss(print).filter(
			(block) => block.path.join("|") === "@page cover",
		);
		expect(
			new Map(atBlock(print, "@page cover").declarations).get("margin"),
		).toBe("0");
		expect(cover).toHaveLength(16);
		for (const box of cover) {
			expect(box.declarations).toEqual([["content", "none"]]);
		}
		for (const box of ["@top-left", "@bottom-left", "@bottom-right"]) {
			expect(cover.map((block) => block.prelude)).toContain(box);
		}
		// The first page repeats it, so page 1 is painted without margins or
		// furniture whatever the browser takes its geometry from.
		const first = parseCss(print).filter(
			(block) => block.path.join("|") === "@page :first",
		);
		expect(
			new Map(atBlock(print, "@page :first").declarations).get("margin"),
		).toBe("0");
		expect(first).toHaveLength(16);
		for (const box of first) {
			expect(box.declarations).toEqual([["content", "none"]]);
		}

		const coverRule = declarationsFor(
			print,
			`${PRINT_ROOT} .${PROPOSAL_THEME_CLASSES.cover}`,
		);
		expect(coverRule.get("page")).toBe("cover");
		expect(coverRule.get("break-after")).toBe("page");
		expect(coverRule.get("background-color")).toBe("var(--pa-ink)");
		// The full-bleed cover is one Letter page tall, and that height is
		// written nowhere else: it follows the page size constant.
		expect(coverRule.get("height")).toBe("11in");
		expect(print.match(/\b11in\b/g)).toHaveLength(1);
		expect(coverRule.get("color")).toBe("var(--pa-surface)");
	});

	it("lets the cover's logo slots collapse cleanly", () => {
		expect(
			declarationsFor(
				print,
				`${PRINT_ROOT} .${PROPOSAL_PRINT_CLASSES.coverBrands}:empty`,
			).get("display"),
		).toBe("none");
		expect(
			declarationsFor(
				print,
				`${PRINT_ROOT} .${PROPOSAL_PRINT_CLASSES.recipientLogo}`,
			).get("margin-inline-start"),
		).toBe("auto");
	});

	it("prints landscape appendix pages on a named page", () => {
		expect(PROPOSAL_PAGE_SIZE_LANDSCAPE).toBe("letter landscape");
		expect(
			new Map(atBlock(print, "@page landscape").declarations).get("size"),
		).toBe(PROPOSAL_PAGE_SIZE_LANDSCAPE);
		expect(
			declarationsFor(
				print,
				`${PRINT_ROOT} .${PROPOSAL_PRINT_CLASSES.landscape}`,
			).get("page"),
		).toBe("landscape");
	});

	it("gives the contents page fixed-width page slots the second print pass fills", () => {
		const rule = (selector: string) =>
			declarationsFor(print, `${PRINT_ROOT} .${selector}`);

		const slot = rule(PROPOSAL_PRINT_CLASSES.contentsPage);
		expect(slot.get("flex")).toBe("0 0 3ch");
		expect(slot.get("width")).toBe("3ch");
		expect(slot.get("text-align")).toBe("right");
		expect(slot.get("font-variant-numeric")).toBe("tabular-nums");
		expect(slot.get("white-space")).toBe("nowrap");

		const leader = rule(PROPOSAL_PRINT_CLASSES.contentsLeader);
		expect(leader.get("flex")).toBe("1 1 auto");
		expect(leader.get("border-bottom")).toBe("1px dotted var(--pa-border)");
	});

	it("lays the first pass's page marker out of flow and draws it, as only that unseen pass carries it", () => {
		expect(
			declarationsFor(print, `${PRINT_ROOT} .pa-section-opener`).get(
				"position",
			),
		).toBe("relative");
		const marker = declarationsFor(
			print,
			`${PRINT_ROOT} .${PROPOSAL_PRINT_CLASSES.pageMarker}`,
		);
		expect(marker.get("position")).toBe("absolute");
		// Not tiny: Linux print output splits a tiny marker glyph by glyph.
		expect(marker.get("font-size")).toBe("8px");
		expect(marker.get("white-space")).toBe("nowrap");
		// Chromium leaves text out of the PDF entirely when it is clipped to a
		// tiny box, and on Linux when it is transparent, so the marker is
		// never clipped, hidden or made see-through.
		for (const property of [
			"overflow",
			"clip",
			"clip-path",
			"visibility",
			"color",
			"opacity",
		]) {
			expect(marker.has(property)).toBe(false);
		}
		expect(marker.get("display")).not.toBe("none");
	});

	it("frames a diagram placeholder and bounds the cover hero", () => {
		expect(
			declarationsFor(
				print,
				`${PRINT_ROOT} .${PROPOSAL_PRINT_CLASSES.diagramPlaceholder}`,
			).get("border"),
		).toBe("1px dashed var(--pa-border)");

		const hero = declarationsFor(
			print,
			`${PRINT_ROOT} .${PROPOSAL_PRINT_CLASSES.coverHero}`,
		);
		expect(hero.get("height")).toBe("3in");
		expect(hero.get("object-fit")).toBe("cover");
		expect(hero.get("flex")).toBe("0 0 auto");
	});

	it("numbers section openers with a counter", () => {
		expect(declarationsFor(print, PRINT_ROOT).get("counter-reset")).toBe(
			"pa-section",
		);
		expect(
			declarationsFor(print, `${PRINT_ROOT} .pa-section-opener`).get(
				"counter-increment",
			),
		).toBe("pa-section");
		const eyebrow = declarationsFor(
			print,
			`${PRINT_ROOT} .pa-section-opener::before`,
		);
		expect(eyebrow.get("content")).toBe('"Section " counter(pa-section)');
		expect(eyebrow.get("text-transform")).toBe("uppercase");
	});

	it("uses no CSS Chromium cannot print", () => {
		expect(print).not.toContain("target-counter");
		expect(print).not.toContain("string-set");
		expect(print).not.toContain("string(");
	});

	it("keeps blocks whole, repeats table headers and prints backgrounds", () => {
		expect(
			declarationsFor(print, `${PRINT_ROOT} thead`).get("display"),
		).toBe("table-header-group");
		const kept = styleRules(print)
			.filter(
				(block) =>
					new Map(block.declarations).get("break-inside") === "avoid",
			)
			.flatMap(selectorsOf);
		for (const part of ["tr", "figure", ".pa-figure", ".pa-stat-tile"]) {
			expect(kept).toContain(`${PRINT_ROOT} ${part}`);
		}
		const body = declarationsFor(print, PRINT_ROOT);
		expect(body.get("print-color-adjust")).toBe("exact");
		expect(body.get("-webkit-print-color-adjust")).toBe("exact");
		expect(body.get("background-color")).toBe("var(--pa-surface)");
	});

	it("cannot be broken out of by the header or footer text", () => {
		const header =
			'Q3 "Plan" \\ for\nExample Org; } body { display: none } </style><script>x</script>';
		const css = proposalThemeCss("print", {
			runningHeader: header,
			runningFooter: "Example Org\r\n\u0000 · Confidential",
		});

		const topLeft = atBlock(css, "@top-left");
		const content = new Map(topLeft.declarations).get("content") as string;
		expect(content).toBe(
			'"Q3 \\"Plan\\" \\\\ for Example Org; } body { display: none } \\3c /style\\3e \\3c script\\3e x\\3c /script\\3e "',
		);
		expect(decodeCssString(content)).toBe(
			'Q3 "Plan" \\ for Example Org; } body { display: none } </style><script>x</script>',
		);
		expect(
			decodeCssString(
				new Map(atBlock(css, "@bottom-left").declarations).get(
					"content",
				) as string,
			),
		).toBe("Example Org · Confidential");
		// The stylesheet keeps the shape it has with harmless text, and never
		// carries a `<` that could close a <style> element.
		const shape = (text: string) =>
			parseCss(text).map((block) =>
				[...block.path, block.prelude].join(" > "),
			);
		expect(shape(css)).toEqual(shape(print));
		expect(css).not.toContain("<");
	});

	it("drops invisible formatting characters from the running text", () => {
		const css = proposalThemeCss("print", {
			runningHeader: "Example Proposal",
			// A right-to-left override would make the furniture read backwards.
			runningFooter: "Example Org \u202e Confidential\u200b",
		});

		expect(
			decodeCssString(
				new Map(atBlock(css, "@bottom-left").declarations).get(
					"content",
				) as string,
			),
		).toBe("Example Org Confidential");
	});

	it("keeps the joiners a title's script needs and drops soft hyphens", () => {
		const css = proposalThemeCss("print", {
			runningHeader:
				"Example Pro\u00adposal \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
			runningFooter: "Example Org",
		});

		expect(
			decodeCssString(
				new Map(atBlock(css, "@top-left").declarations).get(
					"content",
				) as string,
			),
		).toBe(
			"Example Proposal \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
		);
	});

	it("caps the running text and leaves an empty box out", () => {
		const css = proposalThemeCss("print", {
			runningHeader: "a".repeat(500),
			runningFooter: "  \n ",
		});

		const header = decodeCssString(
			new Map(atBlock(css, "@top-left").declarations).get(
				"content",
			) as string,
		);
		expect(Array.from(header)).toHaveLength(200);
		expect(header.endsWith("…")).toBe(true);
		expect(
			new Map(atBlock(css, "@bottom-left").declarations).get("content"),
		).toBe("none");
	});
});
