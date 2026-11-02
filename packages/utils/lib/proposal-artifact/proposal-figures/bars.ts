/**
 * The bars template: a horizontal bar chart drawn from a small subset of
 * Mermaid's `xychart` language, with an optional dashed threshold.
 *
 *   ```mermaid
 *   %% caption: Hours saved per week
 *   %% figure: bars
 *   xychart-beta horizontal
 *     x-axis ["Expected · 5% uplift", "Faster review", Rollout]
 *     y-axis "h" 0 --> 20
 *     bar [12, 9, 15]
 *     line [12, 12, 12]
 *   ```
 *
 * The source stays Mermaid, so whatever cannot draw the template still draws
 * the fence as an xychart. The parser reads a `xychart`/`xychart-beta`
 * header (optionally `horizontal`), an optional `title`, one `x-axis` of
 * category labels, an optional `y-axis` unit and `0 --> max` range, exactly
 * one `bar` series and an optional `line` series whose values are all equal:
 * that line is the threshold. The threshold is a ceiling: bars at or below
 * it are drawn in the primary, bars above it in a grey. Anything else (a
 * second series, a line that is not flat, a negative value, a length
 * mismatch, an `%%{init}` directive, frontmatter, an unknown statement)
 * makes the parser return null, and the fence draws as Mermaid.
 *
 * Values print exactly as the source writes them; nothing is formatted.
 *
 * Pure functions and data only: client components import this module.
 */

import { contrastRatio, mixHex, normalizeHexColor } from "../../brand-colors";
import { GRAPHIC_CONTRAST } from "../../glossy/visual-colors";
import { cleanDiagramCaption } from "../diagram-caption";
import {
	centredWithin,
	charBudget,
	checkedIdPrefix,
	checkedPalette,
	FIGURE_WIDTH,
	type FigureOptions,
	type FigurePalette,
	figureTitle,
	INTER_ADVANCE,
	INTER_EM,
	MONO_TRACKING,
	monoWidth,
	num,
	svgDocument,
	textElement,
	wrapLine,
} from "./svg-text";

// ---------------------------------------------------------------------------
// The xychart subset
// ---------------------------------------------------------------------------

/** A number as the source writes it, and its value. */
export interface BarsNumber {
	value: number;
	/** The token as written: what the chart prints. */
	text: string;
}

export interface BarsEntry extends BarsNumber {
	/** The category label, unquoted. */
	label: string;
}

export interface BarsModel {
	/** The chart's `title`, or null. */
	title: string | null;
	/** The `y-axis` title, printed after the threshold and the scale. */
	unit: string | null;
	/** The `y-axis` range's maximum, or null when there is no range. */
	axisMax: BarsNumber | null;
	/** One entry per category, in source order. */
	bars: BarsEntry[];
	/** The flat `line` series' value, or null. */
	threshold: BarsNumber | null;
}

/** The longest source read at all, in characters. */
const MAX_SOURCE_LENGTH = 20_000;
const BARS_MIN = 2;
const BARS_MAX = 12;
/** A category label's longest length, in code points. */
const BARS_LABEL_MAX_CHARS = 40;
/** The unit's longest length, in code points: it shares a line with a value. */
const BARS_UNIT_MAX_CHARS = 24;
/** A value's longest written form, in code points. */
const VALUE_MAX_CHARS = 16;
const VALUE_MAX = 1e9;

/** The header Mermaid's detector knows, lower case as it requires. */
const HEADER = /^xychart(?:-beta)?(?:\s+horizontal)?$/;
/** A number as Mermaid's lexer reads one, without a sign. */
const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
/** An unquoted label: one word of the characters Mermaid joins into text. */
const UNQUOTED_LABEL = /^[A-Za-z0-9_.&+=*#-]+$/;
/** An unquoted axis title, which must not read as a number or an arrow. */
const UNQUOTED_TITLE = /^[A-Za-z][A-Za-z0-9_.&+=*#]*/;
const RANGE = /^(\S+)\s*-->\s*(\S+)$/;
// C0 and C1 controls and the Unicode line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** One `[a, "b, c"]` item: its text and whether it was quoted. */
interface ListItem {
	text: string;
	quoted: boolean;
}

/**
 * The bracketed list `text` opens with, or null when it is malformed or
 * anything follows its closing bracket. Commas inside quotes are text.
 */
function readList(text: string): ListItem[] | null {
	if (!text.startsWith("[")) {
		return null;
	}
	const items: ListItem[] = [];
	let at = 1;
	for (;;) {
		while (at < text.length && /\s/.test(text[at])) {
			at += 1;
		}
		let item: ListItem;
		if (text[at] === '"') {
			const closing = text.indexOf('"', at + 1);
			if (closing === -1) {
				return null;
			}
			item = { text: text.slice(at + 1, closing), quoted: true };
			at = closing + 1;
			while (at < text.length && /\s/.test(text[at])) {
				at += 1;
			}
		} else {
			const end = text.slice(at).search(/[,\]"]/);
			if (end === -1) {
				return null;
			}
			item = { text: text.slice(at, at + end).trim(), quoted: false };
			at += end;
		}
		if (!item.quoted && item.text === "") {
			return null;
		}
		items.push(item);
		if (text[at] === "]") {
			return text.slice(at + 1).trim() === "" ? items : null;
		}
		if (text[at] !== ",") {
			return null;
		}
		at += 1;
	}
}

/** A written number from 0 to the limit, or null. */
function readNumber(token: string): BarsNumber | null {
	if (!NUMBER.test(token) || Array.from(token).length > VALUE_MAX_CHARS) {
		return null;
	}
	const value = Number(token);
	return Number.isFinite(value) && value >= 0 && value <= VALUE_MAX
		? { value, text: token }
		: null;
}

function readNumbers(items: readonly ListItem[]): BarsNumber[] | null {
	const numbers: BarsNumber[] = [];
	for (const item of items) {
		const number = item.quoted ? null : readNumber(item.text);
		if (!number) {
			return null;
		}
		numbers.push(number);
	}
	return numbers;
}

/**
 * A label as drawn: a quoted one trimmed, an unquoted one a single word.
 * Null when it is empty, too long, holds a control character, or is a
 * Markdown string (in backticks), which Mermaid formats.
 */
function readLabel(item: ListItem, maxChars: number): string | null {
	const text = item.text.trim();
	if (
		text === "" ||
		CONTROL.test(text) ||
		Array.from(text).length > maxChars ||
		(item.quoted ? text.startsWith("`") : !UNQUOTED_LABEL.test(text))
	) {
		return null;
	}
	return text;
}

/**
 * An axis or chart title at the start of `text` (quoted, or one unquoted
 * word), and what follows it; the title is null when there is none. Null
 * when the title is malformed.
 */
function readTitle(
	text: string,
): { title: string | null; rest: string } | null {
	if (text.startsWith('"')) {
		const closing = text.indexOf('"', 1);
		if (closing === -1) {
			return null;
		}
		const title = readLabel(
			{ text: text.slice(1, closing), quoted: true },
			Number.POSITIVE_INFINITY,
		);
		return title === null
			? null
			: { title, rest: text.slice(closing + 1).trim() };
	}
	const word = UNQUOTED_TITLE.exec(text)?.[0];
	if (word === undefined || !/^(?:\s|\[|$)/.test(text.slice(word.length))) {
		return { title: null, rest: text };
	}
	return { title: word, rest: text.slice(word.length).trim() };
}

/** The statement keyword a line opens with, lower case, and the rest. */
function readKeyword(line: string): { keyword: string; rest: string } {
	const keyword = /^(?:x-axis|y-axis|[A-Za-z]+)/i.exec(line)?.[0] ?? "";
	return { keyword: keyword.toLowerCase(), rest: line.slice(keyword.length) };
}

/**
 * The model of an `xychart` in the bars subset, or null when the source is
 * anything else. `%%` comment lines (the marker, caption and figure lines
 * among them) are skipped. Keywords other than the header read in any case,
 * as Mermaid's lexer reads them.
 */
export function parseBarsSource(source: string): BarsModel | null {
	if (source.length > MAX_SOURCE_LENGTH) {
		return null;
	}
	let headerSeen = false;
	let title: string | null | undefined;
	let labels: string[] | undefined;
	let unit: string | null | undefined;
	let axisMax: BarsNumber | null = null;
	let values: BarsNumber[] | undefined;
	let line: BarsNumber[] | undefined;

	for (const raw of source.split(/\r\n?|\n/)) {
		const trimmed = raw.trim();
		if (trimmed === "") {
			continue;
		}
		if (trimmed.startsWith("%%{")) {
			return null;
		}
		if (trimmed.startsWith("%%")) {
			continue;
		}
		if (trimmed.startsWith("---")) {
			return null;
		}
		const statement = trimmed.replace(/;+$/, "").trim();
		if (!headerSeen) {
			if (!HEADER.test(statement)) {
				return null;
			}
			headerSeen = true;
			continue;
		}
		const { keyword, rest: afterKeyword } = readKeyword(statement);
		if (!/^(?:\s|\[|"|$)/.test(afterKeyword)) {
			return null;
		}
		const rest = afterKeyword.trim();
		switch (keyword) {
			case "title": {
				const read = readTitle(rest);
				if (title !== undefined || !read?.title || read.rest !== "") {
					return null;
				}
				title = read.title;
				break;
			}
			case "x-axis": {
				const read = readTitle(rest);
				const items = read ? readList(read.rest) : null;
				if (labels !== undefined || !items) {
					return null;
				}
				const drawn = items.map((item) =>
					readLabel(item, BARS_LABEL_MAX_CHARS),
				);
				if (!drawn.every((label): label is string => label !== null)) {
					return null;
				}
				labels = drawn;
				break;
			}
			case "y-axis": {
				if (unit !== undefined) {
					return null;
				}
				const range = RANGE.exec(rest);
				const read = range ? { title: null, rest } : readTitle(rest);
				if (!read) {
					return null;
				}
				if (
					read.title !== null &&
					Array.from(read.title).length > BARS_UNIT_MAX_CHARS
				) {
					return null;
				}
				unit = read.title;
				if (read.rest !== "") {
					const bounds = RANGE.exec(read.rest);
					const min = bounds ? readNumber(bounds[1]) : null;
					const max = bounds ? readNumber(bounds[2]) : null;
					if (!min || !max || min.value !== 0 || max.value <= 0) {
						return null;
					}
					axisMax = max;
				}
				break;
			}
			case "bar":
			case "line": {
				const read = readTitle(rest);
				const items = read ? readList(read.rest) : null;
				const numbers = items ? readNumbers(items) : null;
				if (!numbers) {
					return null;
				}
				if (keyword === "bar") {
					if (values !== undefined) {
						return null;
					}
					values = numbers;
				} else {
					if (line !== undefined) {
						return null;
					}
					line = numbers;
				}
				break;
			}
			default:
				return null;
		}
	}
	if (!headerSeen || !labels || !values) {
		return null;
	}
	if (
		labels.length < BARS_MIN ||
		labels.length > BARS_MAX ||
		values.length !== labels.length ||
		(line !== undefined && line.length !== labels.length)
	) {
		return null;
	}
	if (line?.some((point) => point.value !== line[0].value)) {
		return null;
	}
	const bars = labels.map((label, index) => ({ label, ...values[index] }));
	return {
		title: title ?? null,
		unit: unit ?? null,
		axisMax,
		bars,
		threshold: line?.[0] ?? null,
	};
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 26;
const BAR_HEIGHT = 14;
/** From a row's top to its text baseline: the bar's middle, less the x-height. */
const ROW_BASELINE = 17;
const LABEL_COLUMN_MAX = 200;
/** Between the label column and the bars' origin. */
const LABEL_GAP = 12;
/** Between a bar's end and its value. */
const VALUE_GAP = 6;
/** Above the rows when there is a threshold: its label's line. */
const THRESHOLD_BAND = 20;
const THRESHOLD_BASELINE = 13;
const TOP_PAD = 4;
/** Below the rows: the axis ends' line. */
const AXIS_BAND = 20;
const AXIS_BASELINE = 16;
/** Round mantissas a computed scale is rounded up to. */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/**
 * The grey for a bar above the threshold: the ink mixed towards the paper,
 * at 1% steps, only as far as still reads at 3:1 there, the floor for
 * graphics. The ink itself when no lighter mix holds.
 */
export function barsOverGrey(ink: string, surface: string): string {
	const inkHex = normalizeHexColor(ink) ?? ink;
	const surfaceHex = normalizeHexColor(surface) ?? surface;
	for (let step = 0; step <= 100; step += 1) {
		const grey = mixHex(inkHex, surfaceHex, step / 100);
		if (contrastRatio(grey, surfaceHex) >= GRAPHIC_CONTRAST) {
			return grey;
		}
	}
	return inkHex;
}

/** `value` rounded up to a round number: a step of NICE_STEPS times 10^n. */
function niceCeiling(value: number): BarsNumber {
	if (value <= 0) {
		return { value: 1, text: "1" };
	}
	let exponent = Math.floor(Math.log10(value));
	if (10 ** exponent > value) {
		exponent -= 1;
	} else if (10 ** (exponent + 1) <= value) {
		exponent += 1;
	}
	const scaled = (step: number) =>
		exponent >= 0 ? step * 10 ** exponent : step / 10 ** -exponent;
	const step = NICE_STEPS.find((candidate) => scaled(candidate) >= value);
	const nice = scaled(step ?? 10);
	const text = nice
		.toFixed(Math.max(0, 1 - exponent))
		.replace(/(\.\d*?)0+$/, "$1")
		.replace(/\.$/, "");
	return { value: nice, text };
}

/**
 * The value the bars scale to: the axis maximum when it holds every value
 * and the threshold, else the largest of them rounded up.
 */
function chartScale(model: BarsModel): BarsNumber {
	const largest = Math.max(
		...model.bars.map((bar) => bar.value),
		model.threshold?.value ?? 0,
	);
	if (model.axisMax && model.axisMax.value >= largest) {
		return model.axisMax;
	}
	return niceCeiling(largest);
}

/**
 * A horizontal bar chart, 662 px wide: the labels in a column as wide as the
 * longest needs (at most 200 px, longer ones cut with an ellipsis), then one
 * bar a row with its value after it, in mono. The widest value's room is
 * kept at the end before the bars are scaled, so a bar at the scale's
 * maximum still has its value inside the figure. A threshold is a dashed
 * line across the rows with its `value unit` above, both in the label
 * colour; the bars above it are grey. Under the rows, `0` and the scale's
 * maximum with its unit mark the axis ends.
 */
export function barsFigureSvg(
	model: BarsModel,
	palette: FigurePalette,
	options: FigureOptions = {},
): string {
	const colors = checkedPalette(palette);
	checkedIdPrefix(options);
	const overGrey = barsOverGrey(colors.ink, colors.surface);
	const unitSuffix = model.unit ? ` ${model.unit}` : "";

	const longest = Math.max(
		...model.bars.map((bar) => Array.from(bar.label).length),
	);
	const labelColumn = Math.min(
		LABEL_COLUMN_MAX,
		Math.ceil(longest * INTER_ADVANCE),
	);
	const labelBudget = charBudget(labelColumn, INTER_EM);
	const origin = labelColumn + LABEL_GAP;
	const valueRoom =
		VALUE_GAP + Math.max(...model.bars.map((bar) => monoWidth(bar.text)));
	const barArea = FIGURE_WIDTH - origin - valueRoom;
	const scale = chartScale(model);
	const xOf = (value: number) => origin + (value / scale.value) * barArea;

	const top = model.threshold ? THRESHOLD_BAND : TOP_PAD;
	const rowsBottom = top + model.bars.length * ROW_HEIGHT;
	const mono = {
		mono: true,
		weight: 500,
		tracking: MONO_TRACKING,
	} as const;
	const body: string[] = [];

	if (model.threshold) {
		const x = xOf(model.threshold.value);
		body.push(
			`<line class="threshold" x1="${num(x)}" y1="${top - 2}" x2="${num(x)}" y2="${num(rowsBottom + 2)}" stroke="${colors.label}" stroke-width="1.3" stroke-dasharray="4 3"/>`,
		);
		const text = `${model.threshold.text}${unitSuffix}`;
		body.push(
			textElement(
				[text],
				centredWithin(x, monoWidth(text), 0, FIGURE_WIDTH),
				THRESHOLD_BASELINE,
				{
					...mono,
					className: "threshold-label",
					fill: colors.label,
					anchor: "middle",
				},
			),
		);
	}

	model.bars.forEach((bar, index) => {
		const rowTop = top + index * ROW_HEIGHT;
		const baseline = rowTop + ROW_BASELINE;
		const over =
			model.threshold !== null && bar.value > model.threshold.value;
		const end = xOf(bar.value);
		body.push(
			textElement(wrapLine(bar.label, labelBudget, 1), 0, baseline, {
				className: "bar-label",
				weight: 400,
				fill: colors.ink,
			}),
		);
		body.push(
			`<rect class="bar" x="${num(origin)}" y="${num(rowTop + (ROW_HEIGHT - BAR_HEIGHT) / 2)}" width="${num(end - origin)}" height="${BAR_HEIGHT}" rx="2" fill="${over ? overGrey : colors.primary}"/>`,
		);
		body.push(
			textElement([bar.text], end + VALUE_GAP, baseline, {
				...mono,
				className: "bar-value",
				fill: colors.muted,
			}),
		);
	});

	const axisBaseline = rowsBottom + AXIS_BASELINE;
	body.push(
		textElement(["0"], origin, axisBaseline, {
			...mono,
			className: "axis-end",
			fill: colors.muted,
			anchor: "middle",
		}),
	);
	const maxText = `${scale.text}${unitSuffix}`;
	const maxEnd = Math.min(
		FIGURE_WIDTH,
		Math.max(
			xOf(scale.value),
			origin + monoWidth("0") + LABEL_GAP + monoWidth(maxText),
		),
	);
	body.push(
		textElement([maxText], maxEnd, axisBaseline, {
			...mono,
			className: "axis-end",
			fill: colors.muted,
			anchor: "end",
		}),
	);

	const spokenBars = model.bars.map(
		(bar) =>
			`${bar.label}: ${bar.text}${unitSuffix}${
				model.threshold !== null && bar.value > model.threshold.value
					? " (above the threshold)"
					: ""
			}`,
	);
	const desc = `Values in order: ${spokenBars.join("; ")}.${
		model.threshold
			? ` Threshold: ${model.threshold.text}${unitSuffix}.`
			: ""
	}`;
	const title =
		cleanDiagramCaption(options.caption) ??
		cleanDiagramCaption(model.title) ??
		figureTitle(options, "bars");
	return svgDocument(rowsBottom + AXIS_BAND, title, desc, body);
}
