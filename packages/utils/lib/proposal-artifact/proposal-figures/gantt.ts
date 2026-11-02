/**
 * The gantt template: a plan in week columns, drawn from a small subset of
 * Mermaid's `gantt` language.
 *
 *   ```mermaid
 *   %% caption: Pilot schedule by workstream
 *   %% figure: gantt
 *   gantt
 *     title Pilot schedule
 *     dateFormat YYYY-MM-DD
 *     section Build
 *     Routing :a1, 2026-11-02, 3w
 *     Work orders :a2, after a1, 21d
 *     section Pilot
 *     Region one :b1, after a2, 4w
 *     Pilot review :milestone, m1, 2027-01-11, 0d
 *   ```
 *
 * The source stays Mermaid, so whatever cannot draw the template still draws
 * the fence as a gantt chart. The parser reads a `gantt` header, an optional
 * `title`, the `dateFormat YYYY-MM-DD` line, `section` lines, and tasks in
 * three forms, each in the section above it: `Name :id, YYYY-MM-DD, Nd`
 * (or `Nw`), `Name :id, after id, Nd` (starting where that task or
 * milestone ends) and the milestone `Name :milestone, id, YYYY-MM-DD, 0d`.
 * Anything else (a tag such as `crit` or `done`, an end date, `after` with
 * several ids or one not declared above, `excludes`, `axisFormat`,
 * `todayMarker`, `click`, an `%%{init}` directive, frontmatter, a task
 * before the first section, an unknown statement) makes the parser return
 * null, and the fence draws as Mermaid. Keywords read in any case, as
 * Mermaid's gantt lexer reads them; the header is lower case, as its
 * detector requires.
 *
 * Dates are calendar days counted in UTC, so the chart is the same wherever
 * it is drawn.
 *
 * Pure functions and data only: client components import this module.
 */

import { cleanDiagramCaption } from "../diagram-caption";
import {
	centredWithin,
	charBudget,
	checkedIdPrefix,
	checkedPalette,
	FIGURE_WIDTH,
	type FigureOptions,
	type FigurePalette,
	FONT_SIZE,
	figureTitle,
	INTER_ADVANCE,
	INTER_EM,
	LINE_HEIGHT,
	MONO_EM,
	MONO_TRACKING,
	monoWidth,
	num,
	svgDocument,
	textElement,
	wrapLine,
} from "./svg-text";

// ---------------------------------------------------------------------------
// The gantt subset
// ---------------------------------------------------------------------------

export interface GanttTask {
	id: string;
	/** The task's name, trimmed. */
	name: string;
	/** Its section's index in `sections`. */
	section: number;
	/** Its first day, in days since 1970-01-01 (UTC). */
	start: number;
	/** The day after its last, in days since 1970-01-01 (UTC). */
	end: number;
}

export interface GanttMilestone {
	id: string;
	/** The milestone's name, trimmed. */
	name: string;
	/** Its section's index in `sections`. */
	section: number;
	/** Its day, in days since 1970-01-01 (UTC). */
	day: number;
}

export interface GanttModel {
	/** The chart's `title`, or null. */
	title: string | null;
	/** Section names in source order. */
	sections: string[];
	/** Tasks in source order. */
	tasks: GanttTask[];
	/** Milestones in source order. */
	milestones: GanttMilestone[];
}

/** The longest source read at all, in characters. */
const MAX_SOURCE_LENGTH = 20_000;
const GANTT_TASKS_MAX = 20;
const GANTT_MILESTONES_MAX = 8;
const GANTT_SECTIONS_MAX = 8;
/** The longest plan drawn, from its first day to its last, in weeks. */
const GANTT_WEEKS_MAX = 52;
/** A task, milestone or section name's longest length, in code points. */
const GANTT_NAME_MAX_CHARS = 60;
const GANTT_TITLE_MAX_CHARS = 120;
/** The most days or weeks one task may last, as written. */
const DURATION_MAX = 366;

const DAY_MS = 86_400_000;
/** The header Mermaid's detector knows, lower case as it requires. */
const HEADER = /^gantt$/;
/**
 * The statements Mermaid's gantt lexer reads before a task name, in any
 * case: a line opening with one is never a task.
 */
const KEYWORD =
	/^(?:gantt|dateformat|inclusiveenddates|topaxis|axisformat|tickinterval|includes|excludes|todaymarker|weekday|weekend|title|accdescription|accdescr|acctitle|section|click|href|call)\b/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DURATION = /^(\d{1,3})([dw])$/;
const AFTER = /^after\s+(\S+)$/;
const TASK_ID = /^[A-Za-z0-9_-]+$/;
/** Words Mermaid reads as a task's tags, never as its id. */
const TAG_WORDS: ReadonlySet<string> = new Set([
	"active",
	"after",
	"crit",
	"done",
	"milestone",
	"vert",
]);
// C0 and C1 controls and the Unicode line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A `YYYY-MM-DD` calendar date as a day number, or null. */
function readDate(text: string): number | null {
	const match = DATE.exec(text);
	if (!match) {
		return null;
	}
	const [year, month, day] = [match[1], match[2], match[3]].map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return date.getTime() / DAY_MS;
}

/** A day number as `YYYY-MM-DD`. */
function isoDate(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** An `Nd`/`Nw` duration in days, or null; `0d` only when `zero`. */
function readDuration(text: string, zero: boolean): number | null {
	const match = DURATION.exec(text);
	if (!match) {
		return null;
	}
	const count = Number(match[1]);
	if (zero ? text !== "0d" : count < 1 || count > DURATION_MAX) {
		return null;
	}
	return match[2] === "w" ? count * 7 : count;
}

/** A name as drawn, or null when it is empty, too long or holds a control. */
function readName(text: string, maxChars: number): string | null {
	const name = text.trim();
	return name === "" ||
		CONTROL.test(name) ||
		Array.from(name).length > maxChars
		? null
		: name;
}

function isTaskId(text: string): boolean {
	return TASK_ID.test(text) && !TAG_WORDS.has(text.toLowerCase());
}

/**
 * The model of a `gantt` in the subset, or null when the source is anything
 * else. `%%` comment lines (the marker, caption and figure lines among them)
 * are skipped.
 */
export function parseGanttSource(source: string): GanttModel | null {
	if (source.length > MAX_SOURCE_LENGTH) {
		return null;
	}
	let headerSeen = false;
	let dateFormatSeen = false;
	let title: string | null = null;
	const sections: string[] = [];
	const tasks: GanttTask[] = [];
	const milestones: GanttMilestone[] = [];
	/** Each declared id and the day it ends, for `after`. */
	const ends = new Map<string, number>();

	for (const raw of source.split(/\r\n?|\n/)) {
		const line = raw.trim();
		if (line === "") {
			continue;
		}
		if (line.startsWith("%%{")) {
			return null;
		}
		if (line.startsWith("%%")) {
			continue;
		}
		if (
			line.startsWith("%") ||
			line.startsWith("---") ||
			CONTROL.test(line)
		) {
			return null;
		}
		if (!headerSeen) {
			if (!HEADER.test(line)) {
				return null;
			}
			headerSeen = true;
			continue;
		}
		const keyword = KEYWORD.exec(line)?.[0];
		if (keyword !== undefined) {
			const rest = line.slice(keyword.length);
			if (!/^\s/.test(rest)) {
				return null;
			}
			switch (keyword.toLowerCase()) {
				case "title": {
					const read = readName(rest, GANTT_TITLE_MAX_CHARS);
					if (title !== null || read === null) {
						return null;
					}
					title = read;
					break;
				}
				case "dateformat": {
					if (dateFormatSeen || rest.trim() !== "YYYY-MM-DD") {
						return null;
					}
					dateFormatSeen = true;
					break;
				}
				case "section": {
					const read = readName(rest, GANTT_NAME_MAX_CHARS);
					if (
						read === null ||
						sections.length >= GANTT_SECTIONS_MAX
					) {
						return null;
					}
					sections.push(read);
					break;
				}
				default:
					return null;
			}
			continue;
		}
		const colon = line.indexOf(":");
		const name =
			colon === -1
				? null
				: readName(line.slice(0, colon), GANTT_NAME_MAX_CHARS);
		const data = line.slice(colon + 1);
		if (name === null || sections.length === 0 || /[#;]/.test(data)) {
			return null;
		}
		const section = sections.length - 1;
		const parts = data.split(",").map((part) => part.trim());
		if (parts[0] === "milestone") {
			const [, id, when, duration] = parts;
			const day = parts.length === 4 ? readDate(when) : null;
			if (
				day === null ||
				!isTaskId(id) ||
				ends.has(id) ||
				readDuration(duration, true) === null ||
				milestones.length >= GANTT_MILESTONES_MAX
			) {
				return null;
			}
			ends.set(id, day);
			milestones.push({ id, name, section, day });
			continue;
		}
		const [id, when, duration] = parts;
		if (parts.length !== 3 || !isTaskId(id) || ends.has(id)) {
			return null;
		}
		const after = AFTER.exec(when)?.[1];
		const start = after === undefined ? readDate(when) : ends.get(after);
		const days = readDuration(duration, false);
		if (
			start === null ||
			start === undefined ||
			days === null ||
			tasks.length >= GANTT_TASKS_MAX
		) {
			return null;
		}
		ends.set(id, start + days);
		tasks.push({ id, name, section, start, end: start + days });
	}
	if (!headerSeen || !dateFormatSeen || tasks.length === 0) {
		return null;
	}
	const model = { title, sections, tasks, milestones };
	return weeksOf(model) > GANTT_WEEKS_MAX ? null : model;
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** Above the rows: the start date and the week numbers. */
const HEADER_BAND = 24;
const HEADER_BASELINE = 15;
/** A section's heading row. */
const SECTION_ROW = 24;
const SECTION_BASELINE = 17;
const ROW_HEIGHT = 26;
const BAR_HEIGHT = 14;
/** From a row's top to its text baseline: the bar's middle, less the x-height. */
const ROW_BASELINE = 17;
/** A bar's gap to its day boundaries, so back-to-back tasks read apart. */
const BAR_INSET = 1;
const BAR_MIN_WIDTH = 2;
const LABEL_COLUMN_MAX = 200;
/** Between the label column and the first week. */
const LABEL_GAP = 12;
/** After the last week: room for a milestone diamond on the last day. */
const RIGHT_PAD = 8;
/** How many weeks one week number may stand for, fewest first. */
const WEEK_STEPS = [1, 2, 4, 8] as const;
/** The least room between two week numbers. */
const WEEK_LABEL_GAP = 8;
/** A milestone diamond's half width and height. */
const DIAMOND = 6;
/** From the rows' bottom to a diamond's middle. */
const DIAMOND_OFFSET = 14;
/** From a diamond's bottom to its label's first baseline. */
const MILESTONE_LABEL_BASELINE = 18;
/** The widest a milestone's name is drawn, in px, on at most two lines. */
const MILESTONE_LABEL_WIDTH = 150;
const MILESTONE_NAME_LINES = 2;
/** The least room between two milestone labels on one line. */
const MILESTONE_GAP = 10;
/** Between two lines of milestone labels. */
const LANE_GAP = 6;
const BOTTOM_PAD = 4;

/** The plan's first day and how many weeks it spans, at least one. */
function spanOf(model: GanttModel): { first: number; weeks: number } {
	const days = [
		...model.tasks.flatMap((task) => [task.start, task.end]),
		...model.milestones.map((milestone) => milestone.day),
	];
	const first = Math.min(...days);
	const last = Math.max(...days);
	return { first, weeks: Math.max(1, Math.ceil((last - first) / 7)) };
}

function weeksOf(model: GanttModel): number {
	return spanOf(model).weeks;
}

/** A task's dates for the description: one day, or its first and last. */
function spokenDates(task: GanttTask): string {
	return task.end - task.start === 1
		? isoDate(task.start)
		: `${isoDate(task.start)} to ${isoDate(task.end - 1)}`;
}

/**
 * A gantt chart, 662 px wide. The label column, as wide as the longest name
 * needs (at most 200 px, longer names cut with an ellipsis), holds the date
 * week 1 begins, each section's heading in mono capitals and each task's
 * name. The weeks share the rest: a numbered column each (numbers thinned
 * when a column is too narrow for one), a task a bar from its first day to
 * its last, in the primary, the first section's bars muted when there are
 * others. Milestones are diamonds in the label colour under the rows, each
 * on a dashed line from the top, with its name and date below; labels too
 * close for one line take another.
 */
export function ganttFigureSvg(
	model: GanttModel,
	palette: FigurePalette,
	options: FigureOptions = {},
): string {
	const colors = checkedPalette(palette);
	checkedIdPrefix(options);
	if (model.tasks.length === 0) {
		throw new TypeError("Gantt figure: no task to draw");
	}
	const { first, weeks } = spanOf(model);
	const startText = isoDate(first);
	const sections = model.sections
		.map((name, index) => ({
			name,
			heading: name.toUpperCase(),
			tasks: model.tasks.filter((task) => task.section === index),
		}))
		.filter((section) => section.tasks.length > 0);

	const longest = Math.max(
		monoWidth(startText),
		...sections.map((section) => monoWidth(section.heading)),
		...model.tasks.map(
			(task) => Array.from(task.name).length * INTER_ADVANCE,
		),
	);
	const labelColumn = Math.min(LABEL_COLUMN_MAX, Math.ceil(longest));
	const nameBudget = charBudget(labelColumn, INTER_EM);
	const headingBudget = charBudget(labelColumn, MONO_EM, MONO_TRACKING);
	const origin = labelColumn + LABEL_GAP;
	const chartWidth = FIGURE_WIDTH - origin - RIGHT_PAD;
	const columnWidth = chartWidth / weeks;
	const xOf = (day: number) =>
		origin + ((day - first) / (weeks * 7)) * chartWidth;
	const mono = {
		mono: true,
		weight: 500,
		tracking: MONO_TRACKING,
	} as const;

	const rows: string[] = [];
	let top = HEADER_BAND;
	sections.forEach((section, index) => {
		if (index > 0) {
			rows.push(
				`<line class="section-rule" x1="0" y1="${num(top)}" x2="${FIGURE_WIDTH}" y2="${num(top)}" stroke="${colors.border}" stroke-width="1"/>`,
			);
		}
		rows.push(
			textElement(
				wrapLine(section.heading, headingBudget, 1),
				0,
				top + SECTION_BASELINE,
				{ ...mono, className: "section", fill: colors.muted },
			),
		);
		top += SECTION_ROW;
		const fill =
			sections.length > 1 && index === 0 ? colors.muted : colors.primary;
		for (const task of section.tasks) {
			rows.push(
				textElement(
					wrapLine(task.name, nameBudget, 1),
					labelColumn,
					top + ROW_BASELINE,
					{
						className: "task-label",
						weight: 600,
						fill: colors.ink,
						anchor: "end",
					},
				),
			);
			const x = xOf(task.start) + BAR_INSET;
			const width = Math.max(
				BAR_MIN_WIDTH,
				xOf(task.end) - BAR_INSET - x,
			);
			rows.push(
				`<rect class="task" x="${num(x)}" y="${num(top + (ROW_HEIGHT - BAR_HEIGHT) / 2)}" width="${num(width)}" height="${BAR_HEIGHT}" rx="2" fill="${fill}"/>`,
			);
			top += ROW_HEIGHT;
		}
	});
	const rowsBottom = top;

	const header: string[] = [
		textElement([startText], labelColumn, HEADER_BASELINE, {
			...mono,
			className: "week-start",
			fill: colors.muted,
			anchor: "end",
		}),
	];
	const widest = monoWidth(`W${weeks}`);
	const step =
		WEEK_STEPS.find(
			(candidate) => candidate * columnWidth >= widest + WEEK_LABEL_GAP,
		) ?? WEEK_STEPS[WEEK_STEPS.length - 1];
	const grid: string[] = [];
	for (let week = 1; week <= weeks; week += step) {
		const left = origin + (week - 1) * columnWidth;
		grid.push(
			`<line class="grid" x1="${num(left)}" y1="${HEADER_BAND - 4}" x2="${num(left)}" y2="${num(rowsBottom)}" stroke="${colors.border}" stroke-width="1"/>`,
		);
		const label = `W${week}`;
		header.push(
			textElement(
				[label],
				centredWithin(
					left + columnWidth / 2,
					monoWidth(label),
					origin,
					FIGURE_WIDTH,
				),
				HEADER_BASELINE,
				{
					...mono,
					className: "week",
					fill: colors.muted,
					anchor: "middle",
				},
			),
		);
	}
	const end = origin + chartWidth;
	grid.push(
		`<line class="grid" x1="${num(end)}" y1="${HEADER_BAND - 4}" x2="${num(end)}" y2="${num(rowsBottom)}" stroke="${colors.border}" stroke-width="1"/>`,
	);

	const { parts: milestoneParts, height: milestoneHeight } = drawMilestones(
		model,
		xOf,
		rowsBottom,
		colors,
	);

	const spokenSections = sections.map(
		(section) =>
			`${section.name}: ${section.tasks
				.map((task) => `${task.name}, ${spokenDates(task)}`)
				.join("; ")}.`,
	);
	const spokenMilestones =
		model.milestones.length > 0
			? ` Milestones: ${model.milestones
					.map(
						(milestone) =>
							`${milestone.name}, ${isoDate(milestone.day)}`,
					)
					.join("; ")}.`
			: "";
	const desc = `Week 1 begins ${startText}. ${spokenSections.join(" ")}${spokenMilestones}`;
	const title =
		cleanDiagramCaption(options.caption) ??
		cleanDiagramCaption(model.title) ??
		figureTitle(options, "gantt");
	return svgDocument(rowsBottom + milestoneHeight, title, desc, [
		...grid,
		...header,
		...rows,
		...milestoneParts,
	]);
}

interface PlacedMilestone {
	x: number;
	centre: number;
	name: string[];
	date: string;
	lane: number;
}

/**
 * The milestones under the rows, and the height they take: a dashed line
 * from the top of the rows to each diamond, and each one's name and date
 * centred under it (kept inside the figure), on the first line of labels
 * where it clears the label before it.
 */
function drawMilestones(
	model: GanttModel,
	xOf: (day: number) => number,
	rowsBottom: number,
	colors: FigurePalette,
): { parts: string[]; height: number } {
	if (model.milestones.length === 0) {
		return { parts: [], height: BOTTOM_PAD };
	}
	const nameBudget = charBudget(MILESTONE_LABEL_WIDTH, INTER_EM);
	const lanes: { right: number; lines: number }[] = [];
	const placed: PlacedMilestone[] = model.milestones
		.map((milestone, index) => ({
			milestone,
			index,
			x: xOf(milestone.day),
		}))
		.sort((a, b) => a.x - b.x || a.index - b.index)
		.map(({ milestone, x }) => {
			const name = wrapLine(
				milestone.name,
				nameBudget,
				MILESTONE_NAME_LINES,
			);
			const date = isoDate(milestone.day);
			const width = Math.max(
				monoWidth(date),
				...name.map((line) => Array.from(line).length * INTER_ADVANCE),
			);
			const centre = centredWithin(x, width, 0, FIGURE_WIDTH);
			const left = centre - width / 2;
			let lane = lanes.findIndex(
				(candidate) => candidate.right + MILESTONE_GAP <= left,
			);
			if (lane === -1) {
				lane = lanes.length;
				lanes.push({ right: 0, lines: 0 });
			}
			lanes[lane].right = centre + width / 2;
			lanes[lane].lines = Math.max(lanes[lane].lines, name.length + 1);
			return { x, centre, name, date, lane };
		});

	const diamondY = rowsBottom + DIAMOND_OFFSET;
	const laneTops: number[] = [];
	let laneTop = diamondY + DIAMOND + MILESTONE_LABEL_BASELINE;
	for (const lane of lanes) {
		laneTops.push(laneTop);
		laneTop += lane.lines * LINE_HEIGHT + LANE_GAP;
	}
	const parts: string[] = [];
	for (const { x, centre, name, date, lane } of placed) {
		parts.push(
			`<line class="milestone-guide" x1="${num(x)}" y1="${HEADER_BAND - 4}" x2="${num(x)}" y2="${num(diamondY - DIAMOND)}" stroke="${colors.label}" stroke-width="1" stroke-dasharray="3 3"/>`,
			`<path class="milestone" d="M ${num(x)} ${num(diamondY - DIAMOND)} L ${num(x + DIAMOND)} ${num(diamondY)} L ${num(x)} ${num(diamondY + DIAMOND)} L ${num(x - DIAMOND)} ${num(diamondY)} Z" fill="${colors.label}"/>`,
			textElement(name, centre, laneTops[lane], {
				className: "milestone-label",
				weight: 600,
				fill: colors.ink,
				anchor: "middle",
			}),
			textElement(
				[date],
				centre,
				laneTops[lane] + name.length * LINE_HEIGHT,
				{
					mono: true,
					weight: 500,
					tracking: MONO_TRACKING,
					className: "milestone-date",
					fill: colors.label,
					anchor: "middle",
				},
			),
		);
	}
	const lastLane = lanes[lanes.length - 1];
	const lastBaseline =
		laneTops[lanes.length - 1] + (lastLane.lines - 1) * LINE_HEIGHT;
	return {
		parts,
		height:
			lastBaseline - rowsBottom + (LINE_HEIGHT - FONT_SIZE) + BOTTOM_PAD,
	};
}
