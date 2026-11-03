/**
 * Synthetic Proposals for the print e2e (`proposal-export-print.e2e.test.ts`).
 * Every name, figure and domain here is made up.
 *
 * - `FULL_PROPOSAL`: everything the print design draws. A cover lead of the
 *   longest length the cover takes, a three-tile key-figures block and a
 *   cover fence setting every cover detail before the first H2; a cover
 *   letter as the first H2, printed on its own page; openers with italic
 *   subtitles; an id table, a callout and bold-led steps; hand-written
 *   process, timeline, layers and team figures; a plain Mermaid flowchart; a
 *   gantt with a milestone, drawn from its template; a fence with a broken
 *   header (left out);
 *   card grids, two columns, a bars figure and a bars fence its template
 *   refuses (printed as a plain chart); a layers figure with three-word
 *   names and long descriptions and a timeline whose eyebrows are phrases;
 *   a section without a subtitle whose last paragraph runs onto a page of
 *   its own, then a one-paragraph section that opens below it; and an
 *   appendix holding a table without a header row.
 * - `GENERATED_PROPOSAL`: shaped like a generated Main: a leading `#` title
 *   that differs from the document's name, no preamble, no subtitles, and
 *   process and timeline fences written by the real visual templating with
 *   their figure line, as generation writes them.
 * - `OLDER_PROPOSAL`: shaped like a Main from before figure lines: plain
 *   Mermaid fences, each after its section's first paragraph as the
 *   visuals step places one, a top-down chain of twelve steps, which draws
 *   as a grid of numbered steps, and a sideways chain of four labels under
 *   40 characters, two of them dense in dashes, m, w and hyphens, which
 *   stays a Mermaid layout.
 * - `LONG_OPENER_PROPOSAL`: one section whose opener is as tall as a
 *   generated one gets: a heading on three lines and a subtitle of the
 *   longest length an opener takes, then a top-down chain of twenty steps
 *   right under it, which draws as a grid of numbered steps.
 * - `BRANCHED_OPENER_PROPOSAL`: one section whose opener has a heading and
 *   a short subtitle, then right under it a top-down flowchart with a
 *   branch and a join, taller than the room the opener leaves at the
 *   labels' print floor.
 * - `SHRUNK_OPENER_PROPOSAL`: one section whose opener has a heading on
 *   three lines and a short subtitle, then right under it a shorter
 *   top-down flowchart with a branch and a join, a little taller than the
 *   room the opener leaves, at which its labels still print above the floor.
 */
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import {
	proposalFigureKind,
	proposalVisualTemplateOptions,
	visualSpecToMermaid,
} from "@repo/utils/glossy/visual-templates";
import { withFigureKind } from "@repo/utils/proposal-artifact/proposal-figures";
import { toMermaidFence } from "@repo/utils/proposal-artifact/visual-insert";

export const PROPOSER_NAME = "Example Studio";
export const RECIPIENT_NAME = "Example Harbor Co";

/** Long enough to wrap to the three lines the cover title may take. */
export const FULL_TITLE =
	"A field service modernisation pilot for Example Harbor Co regional crews";

/** The generated fixture's document name; its Main's `#` title replaces it. */
export const GENERATED_TITLE = "Field service pilot proposal";

/** The `#` title a generated Main opens with: the printed title. */
export const GENERATED_H1 = "A mobile work order pilot for Example Harbor Co";

/** Exactly the longest lead the cover takes (320 characters). */
export const COVER_LEAD =
	"Example Studio proposes a twelve-week pilot that moves Example Harbor Co dispatch and field crews from paper work orders to one shared mobile workflow, starting with the regional routes that carry the most repeat visits and ending with a measured review of cost, response time and crew adoption before any wider rollout.";

/** The body paragraph every fixture's sections use. */
export const PARAGRAPH =
	"Software teams effectively identify the difficult parts of a workflow first, then focus the pilot on the stages that matter most to the people who run it.";

/** A section's heading as typed, its subtitle, and its body. */
interface FixtureSection {
	heading: string;
	subtitle: string | null;
	body: string[];
}

/** The text that names the broken fence; none of it may print. */
export const BROKEN_FENCE_TEXT = [
	"Zephyrquartz broken caption",
	"Quillmorrow broken node",
	"Vantablix broken node",
];

/** How many figures fixture (a) numbers: every fence but the broken one. */
export const FULL_FIGURE_COUNT = 10;

/** The gantt's order among fixture (a)'s fences, and its figure number. */
export const FULL_GANTT_FENCE = 6;
export const FULL_GANTT_FIGURE = 6;

/**
 * The layers figure and the plain flowchart after it, under the solution
 * architecture opener: their figure numbers. Together they fit on the
 * opener's page.
 */
export const FULL_LAYERS_FIGURE = 3;
export const FULL_FLOWCHART_FIGURE = 4;

/** The gantt's milestone, on the last day of its last task. */
export const FULL_GANTT_MILESTONE = "Pilot review";

/** The figure-template fences of fixture (a), by their order among fences. */
export const FULL_TEMPLATE_FENCES = [0, 1, 2, 4, 6, 7, 9, 10];

/**
 * The layers fence with three-word names and long descriptions, and the
 * timeline fence whose eyebrows are phrases, by their order among fixture
 * (a)'s fences.
 */
export const FULL_LONG_LAYERS_FENCE = 9;
export const FULL_LONG_TIMELINE_FENCE = 10;

/** A layer: its name, its description (if any), and its boxes. */
interface FixtureLayer {
	name: string;
	description: string | null;
	boxes: string[];
}

/**
 * The long layers' description too long for its row: the figure leaves it
 * out rather than cut it.
 */
export const FULL_LONG_LAYER_LEFT_OUT =
	"orders, parts reservations and crew positions pass between the work order system and the app through one queue that holds every change while a van is out of signal and replays it in order once the van reconnects";

/**
 * Layers named in three words, as generation names them, each but the last
 * with a sentence for a description; the name column holds the first two
 * whole and leaves the third out.
 */
export const FULL_LONG_LAYERS: readonly FixtureLayer[] = [
	{
		name: "Scheduling and dispatch",
		description: "work is planned by region the evening before each shift",
		boxes: [
			"route builder",
			"shift planner",
			"crew roster",
			"parts reservation",
		],
	},
	{
		name: "Records and compliance",
		description: "every change is kept with who made it and why",
		boxes: ["audit history", "photo evidence", "safety checklists"],
	},
	{
		name: "Integration and synchronisation",
		description: FULL_LONG_LAYER_LEFT_OUT,
		boxes: [
			"order system bridge",
			"offline queue",
			"retry handling",
			"interoperability gateway",
		],
	},
	{
		name: "Reporting and finance",
		description: null,
		boxes: ["cost dashboards", "invoice export"],
	},
];

/**
 * Timeline steps whose first line, the mono eyebrow, is a phrase rather
 * than a date: each step's eyebrow, title and detail. One phrase holds a
 * word wider than the eyebrow; the others wrap past its three lines.
 */
export const FULL_LONG_TIMELINE: readonly (readonly [
	string,
	string,
	string,
])[] = [
	[
		"Confirm the rollout order with each regional lead",
		"Rollout plan",
		"One region at a time",
	],
	[
		"Train neighbourhood supervisors",
		"Supervisor training",
		"Two sessions per depot",
	],
	[
		"Move the remaining depots across in two waves",
		"Depot moves",
		"Paper forms kept as backup",
	],
	[
		"Retire the paper forms everywhere",
		"Paper retired",
		"Measured against the baseline",
	],
];

/**
 * The bars fence of fixture (a) its template refuses (thirteen bars, one
 * past its limit): its order among fences, its figure number after the
 * broken fence, and its caption.
 */
export const FULL_REFUSED_BARS_FENCE = 8;
export const FULL_REFUSED_BARS_FIGURE = 8;
export const FULL_REFUSED_BARS_CAPTION =
	"Repeat visits per week before the pilot";

/** What fixture (a)'s cover fence sets, each line as written. */
export const FULL_COVER = {
	eyebrow: "Business case · For operations leadership",
	organization: "Example Harbor Co · Regional field operations",
	forLines: ["Example Harbor Co", "Operations leadership, northern region"],
	byLines: [
		"Example Studio delivery team",
		"1 Example Quay, Example City",
		"example.com",
	],
	version: "3",
} as const;

/** Fixture (a)'s cover letter: what its page must show. */
export const FULL_LETTER = {
	heading: "Cover letter",
	date: "23 October 2026",
	subject: "Re: A twelve-week field service pilot for the regional crews",
	signer: "Jordan Example",
	signerRole: "Engagement lead, Example Studio · dev@example.com",
} as const;

/** The heading of fixture (a)'s appendix, and the letter it is numbered by. */
export const FULL_APPENDIX_HEADING = "Appendix A · Sources";
export const FULL_APPENDIX_LETTER = "A";

const fence = (...lines: string[]) =>
	["```mermaid", ...lines, "```"].join("\n");

const PROCESS_FENCE = fence(
	"%% caption: How one scope line moves from request to release",
	"%% figure: process",
	"flowchart TD",
	'  s1["Scope<br/>Agree what done looks like with both teams"]',
	'  s2["Design<br/>Sketch the screens with two crew leads"]',
	'  s3["Build<br/>Ship the work order flow behind a flag"]',
	'  s4["Review<br/>Walk the flow with dispatch every Friday"]',
	'  s5["Release<br/>Turn it on for one region"]',
	"  s1 --> s2 --> s3 --> s4 --> s5",
	"  class s3 highlight",
	"  s5 -.->|next scope line| s1",
);

const TIMELINE_FENCE = fence(
	"%% caption: Twelve weeks from kickoff to the pilot review",
	"%% figure: timeline",
	"flowchart TD",
	'  t1["Week 1<br/>Kickoff<br/>Interviews with dispatch and crews"]',
	'  t2["Weeks 2-5<br/>First build<br/>Work orders and routing"]',
	'  t3["Weeks 6-9<br/>Pilot region<br/>Forty crews on the app"]',
	'  t4["Weeks 10-12<br/>Review<br/>Cost, response time, adoption"]',
	"  t1 --> t2 --> t3 --> t4",
);

const LAYERS_FENCE = fence(
	"%% caption: Where the pilot sits in the current systems",
	"%% figure: layers",
	"flowchart TB",
	'subgraph experience["Experience<br/>who uses it"]',
	'  e1["Crew app"]',
	'  e2["Dispatcher console"]',
	"end",
	'subgraph services["Services"]',
	'  v1["Routing"]',
	'  v2["Work orders"]',
	'  v3["Parts reservation"]',
	"end",
	'subgraph integration["Integration"]',
	'  i1["Order system"]',
	"end",
	'subgraph data["Data"]',
	'  d1["Store"]',
	'  d2["Event log"]',
	"end",
	'subgraph crosscutting["Cross-cutting"]',
	'  x1["Identity"]',
	'  x2["Audit log"]',
	"end",
	"class v2 highlight",
);

const TEAM_FENCE = fence(
	"%% caption: Who works with whom during the pilot",
	"%% figure: team",
	"flowchart LR",
	'subgraph pod["Example Studio pod<br/>Four people, full time"]',
	'  p1["Engagement lead<br/>Owns scope and the weekly review"]',
	'  p2["Senior engineer<br/>Mobile and offline sync"]',
	'  p3["Product designer<br/>Crew research and flows"]',
	'  p4["QA engineer<br/>Field testing"]',
	"end",
	'subgraph client["Example Harbor Co<br/>Named owners"]',
	'  c1["Operations sponsor<br/>Approves milestones"]',
	'  c2["Crew leads<br/>Two per region"]',
	'  c3["IT owner<br/>Access and integrations"]',
	'  c4["Finance partner<br/>Pilot budget"]',
	"end",
	'r["Daily stand-up<br/>weekly review"]',
	"p1 -.-> c4",
	"p2 --> c3",
	"p3 --> c2",
	"p4 --> c1",
	"p1 --> r",
	"r --> c1",
);

const FLOWCHART_FENCE = fence(
	"%% caption: How a work order reaches a crew",
	"flowchart TD",
	"  A[Dispatcher] --> B[Routing service]",
	"  B --> C[Crew app]",
	"  C --> D[Work order closed]",
);

const BROKEN_FENCE = fence(
	`%% caption: ${BROKEN_FENCE_TEXT[0]}`,
	"flowchart LRt0TD",
	`  Q1[${BROKEN_FENCE_TEXT[1]}] --> Q2[${BROKEN_FENCE_TEXT[2]}]`,
);

const GANTT_FENCE = fence(
	"%% caption: Pilot schedule by workstream",
	"%% figure: gantt",
	"gantt",
	"  title Pilot schedule",
	"  dateFormat YYYY-MM-DD",
	"  section Build",
	"  Routing :a1, 2026-11-02, 21d",
	"  Work orders :a2, after a1, 21d",
	"  section Pilot",
	"  Region one :b1, after a2, 4w",
	`  ${FULL_GANTT_MILESTONE} :milestone, m1, 2027-01-11, 0d`,
);

const BARS_FENCE = fence(
	"%% caption: Months to recover the pilot fee by scenario",
	"%% figure: bars",
	"xychart-beta horizontal",
	'  x-axis ["Expected, 5% uplift", "Expected, 10% uplift", "Expected, 15% uplift", "Cautious, 5% uplift", "Cautious, 10% uplift", "Cautious, 15% uplift"]',
	'  y-axis "months" 0 --> 30',
	"  bar [9.1, 4.6, 3.0, 28, 14, 9.5]",
	"  line [12, 12, 12, 12, 12, 12]",
);

/** Thirteen weeks of bars: one past the bars template's limit. */
const REFUSED_BARS_FENCE = fence(
	`%% caption: ${FULL_REFUSED_BARS_CAPTION}`,
	"%% figure: bars",
	"xychart-beta",
	`  x-axis [${Array.from({ length: 13 }, (_, index) => `W${index + 1}`).join(", ")}]`,
	'  y-axis "visits" 0 --> 60',
	"  bar [42, 38, 45, 40, 36, 44, 47, 39, 41, 37, 43, 46, 40]",
);

const LONG_LAYERS_FENCE = fence(
	"%% caption: How the platform behind the rollout is layered",
	"%% figure: layers",
	"flowchart TB",
	...FULL_LONG_LAYERS.flatMap((layer, row) => [
		`subgraph r${row}["${[layer.name, layer.description].filter(Boolean).join("<br/>")}"]`,
		...layer.boxes.map((box, index) => `  r${row}b${index}["${box}"]`),
		"end",
	]),
);

const LONG_TIMELINE_FENCE = fence(
	"%% caption: Rollout stages after the pilot review",
	"%% figure: timeline",
	"flowchart TD",
	...FULL_LONG_TIMELINE.map(
		(step, index) => `  w${index + 1}["${step.join("<br/>")}"]`,
	),
	`  ${FULL_LONG_TIMELINE.map((_, index) => `w${index + 1}`).join(" --> ")}`,
);

/** A grid of labelled cards, two to a row. */
const CARDS_FENCE = [
	"```cards",
	"Route planning",
	"Crew leads rebuild the day's route by hand each morning, and changes reach them by phone.",
	"",
	"Parts availability",
	"About a third of repeat visits happen because the right part was not on the van.",
	"",
	"Work order close",
	"Paper work orders reach the office two days after the job and are **typed in again**.",
	"",
	"Reporting",
	"Operations and finance count completed jobs differently, so weekly figures never match.",
	"```",
].join("\n");

/** Cards with a number, a label and a bold title, two to a row. */
const TITLED_CARDS_FENCE = [
	"```cards",
	"01 · Fewer repeat visits",
	"**The part is on the van before the crew leaves**",
	"Parts are reserved against each job the night before, from the nearest depot that holds them.",
	"",
	"02 · Shorter mornings",
	"**Routes arrive ready, not rebuilt**",
	"The day's route reaches the crew lead at six, ordered by travel time, with access notes for each stop.",
	"```",
].join("\n");

/** Three numbered tiles share one row. */
const NUMBERED_CARDS_FENCE = [
	"```cards",
	"01",
	"Repeat visits fall when parts are reserved ahead, checked against the depot log.",
	"",
	"02",
	"Crew leads accept a route they did not build, checked in the weekly review.",
	"",
	"03",
	"Work orders closed on site need no retyping, checked by sampling twenty jobs a week.",
	"```",
].join("\n");

const COLUMNS_FENCE = [
	"```columns",
	"### In the pilot",
	"- A route view for every crew lead, ordered by travel time",
	"- Parts reserved against each job from the nearest depot",
	"- Work orders closed on site with photos and a signature",
	"---",
	"### Planned for later",
	"- Customer notices before each visit",
	"- Contractor crews and the remaining regions",
	"### Dependencies",
	"Example Harbor Co names a sponsor and a crew lead per region, and opens a test tenant of the work order system.",
	"```",
].join("\n");

/** A two-column table whose header row is empty: printed without a header. */
const HEADERLESS_TABLE = [
	"|  |  |",
	"| --- | --- |",
	"| Depot log | Repeat visits by route over the last two quarters, kept by the depot leads. |",
	"| Crew survey | Twelve questions answered by forty crew members before the pilot. |",
	"| Finance count | Completed jobs by week, reconciled with operations for one month. |",
].join("\n");

/**
 * Fixture (a)'s field notes: ten paragraphs under an opener without a
 * subtitle. Nine fill the opener's page, and the tenth runs onto the next
 * as a short tail: alone there, it would fill 7% of that page's body.
 */
const FULL_FIELD_NOTES_HEADING = "Field notes";
export const FULL_FIELD_NOTES = Array.from(
	{ length: 10 },
	(_, index) =>
		`Paragraph ${index + 1}. The example team reviews each stage of the workflow with the people who run it, records what slows them down, and agrees on the measures the pilot should move before any build starts. Each finding is checked against the example data set.`,
);

/** The section after the field notes: it opens below their short tail. */
export const FULL_NEXT_STEPS_HEADING = "Next steps";

/** Fixture (a)'s sections: titles none of which contains another. */
export const FULL_SECTIONS: readonly FixtureSection[] = [
	{
		heading: "1. Executive summary",
		subtitle: "A pilot that pays for itself within one season.",
		body: [PARAGRAPH, PARAGRAPH],
	},
	{
		heading: "2. Scope and requirements",
		subtitle: "What the pilot covers, line by line.",
		body: [
			PARAGRAPH,
			[
				"| ID | Requirement | Priority |",
				"| --- | --- | --- |",
				"| FS-01 | Crews receive and close work orders on a phone | Must |",
				"| FS-02 | Dispatch sees each crew's position and status | Must |",
				"| FS-03 | Parts are reserved when a job is scheduled | Should |",
				"| FS-04 | Work orders sync when the signal returns | Must |",
			].join("\n"),
			"> **Out of scope for the pilot.** Billing, payroll and the customer portal stay as they are; the review decides whether they follow.",
		],
	},
	{
		heading: "3. Delivery approach",
		subtitle: "How each scope line moves from request to release.",
		body: [
			[
				"1. **Discover.** Ride along with two crews and map the current paper flow.",
				"2. **Build.** Ship the work order flow behind a flag, one route at a time.",
				"3. **Release.** Turn it on for one region and measure every visit.",
			].join("\n"),
			PROCESS_FENCE,
			TIMELINE_FENCE,
		],
	},
	{
		heading: "4. Solution architecture",
		subtitle: "The pilot adds a thin layer over the systems in place.",
		body: [PARAGRAPH, LAYERS_FENCE, FLOWCHART_FENCE],
	},
	{
		heading: "5. Team and governance",
		subtitle: "Small, named and in the room every week.",
		body: [PARAGRAPH, TEAM_FENCE, BROKEN_FENCE, GANTT_FENCE],
	},
	{
		heading: "6. Value and evidence",
		subtitle:
			"Where the pilot earns its keep, and how each claim is checked.",
		body: [
			PARAGRAPH,
			CARDS_FENCE,
			"### What changes for each team",
			TITLED_CARDS_FENCE,
			"### Assumptions to validate",
			NUMBERED_CARDS_FENCE,
			COLUMNS_FENCE,
			BARS_FENCE,
			REFUSED_BARS_FENCE,
		],
	},
	{
		heading: "7. Rollout and operations",
		subtitle: "What follows the pilot review, region by region.",
		body: [PARAGRAPH, LONG_LAYERS_FENCE, LONG_TIMELINE_FENCE],
	},
	{
		heading: FULL_FIELD_NOTES_HEADING,
		subtitle: null,
		body: FULL_FIELD_NOTES,
	},
	{
		heading: FULL_NEXT_STEPS_HEADING,
		subtitle: null,
		body: [
			"Example Harbor Co confirms the pilot region and names its sponsor.",
		],
	},
	{
		heading: FULL_APPENDIX_HEADING,
		subtitle: "Every figure in this document, with its source.",
		body: [PARAGRAPH, HEADERLESS_TABLE],
	},
];

function sectionsMarkdown(sections: readonly FixtureSection[]): string[] {
	return sections.flatMap((section) => [
		`## ${section.heading}`,
		...(section.subtitle ? [`*${section.subtitle}*`] : []),
		...section.body,
	]);
}

/** Every cover detail, after the stat tiles: the lead stays a lead. */
const COVER_FENCE = [
	"```cover",
	`eyebrow: ${FULL_COVER.eyebrow}`,
	`organization: ${FULL_COVER.organization}`,
	...FULL_COVER.forLines.map((line) => `for: ${line}`),
	...FULL_COVER.byLines.map((line) => `by: ${line}`),
	`version: ${FULL_COVER.version}`,
	"```",
].join("\n");

/**
 * The cover letter, Main's first H2: a date, an addressee, a subject line,
 * two paragraphs, a closing, the signer in bold and the line under them.
 */
const COVER_LETTER = [
	`## ${FULL_LETTER.heading}`,
	FULL_LETTER.date,
	"To the operations leadership of Example Harbor Co",
	FULL_LETTER.subject,
	"Thank you for the time your dispatch team and crew leads gave us over the last month. What we heard is simple: the paper work order costs your crews a morning a week, and the repeat visits it causes cost your customers their patience.",
	"This proposal sets out a twelve-week pilot in one region, the people who would run it on both sides, and the measures the review would use to decide whether it goes further. We would be glad to walk your board through it in person.",
	"Sincerely,",
	`**${FULL_LETTER.signer}**`,
	FULL_LETTER.signerRole,
];

export const FULL_PROPOSAL = [
	COVER_LEAD,
	[
		"```stat-tiles",
		"Weeks to the pilot review: 12",
		"Crews in the pilot region: 40",
		"Fewer repeat visits targeted: 35%",
		"```",
	].join("\n"),
	COVER_FENCE,
	...COVER_LETTER,
	...sectionsMarkdown(FULL_SECTIONS),
].join("\n\n");

/** A fixed generated-visual id, in the marker's own shape. */
const VISUAL_ID = "k3v9q2m7x1a8c4d6";

/** A spec as generation writes its fence: the templating and the figure line. */
function generatedFence(spec: VisualSpec): string {
	return toMermaidFence(
		withFigureKind(
			visualSpecToMermaid(spec, proposalVisualTemplateOptions(spec)),
			proposalFigureKind(spec),
		),
		VISUAL_ID,
	);
}

export const GENERATED_SECTIONS: readonly FixtureSection[] = [
	{
		heading: "1. Executive summary",
		subtitle: null,
		body: [PARAGRAPH, PARAGRAPH],
	},
	{
		heading: "2. Delivery approach",
		subtitle: null,
		body: [
			PARAGRAPH,
			generatedFence({
				kind: "flow",
				steps: [
					{
						label: "Map the current workflow",
						description: "Ride along with two crews",
					},
					{
						label: "Define the pilot scope",
						description: "Agree what done looks like",
					},
					{
						label: "Build and validate",
						description: "One route at a time",
					},
					{
						label: "Review the results",
						description: "Cost, response time, adoption",
					},
					{
						label: "Decide on rollout",
						description: "With the operations sponsor",
					},
				],
			}),
			"- Map the selected workflow and its current tools.\n- Define the context the pilot needs.\n- Configure and validate the agreed scope.",
		],
	},
	{
		heading: "3. Timeline",
		subtitle: null,
		body: [
			PARAGRAPH,
			generatedFence({
				kind: "timeline",
				items: [
					{
						date: "Week 1",
						label: "Kickoff",
						description: "Interviews",
					},
					{ date: "Weeks 2-5", label: "First build" },
					{ date: "Weeks 6-9", label: "Pilot region" },
					{
						date: "Weeks 10-12",
						label: "Review",
						description: "Measured against the baseline",
					},
				],
			}),
		],
	},
];

export const GENERATED_PROPOSAL = [
	`# ${GENERATED_H1}`,
	...sectionsMarkdown(GENERATED_SECTIONS),
].join("\n\n");

/** How many figures fixture (b) numbers. */
export const GENERATED_FIGURE_COUNT = 2;

/** Fixture (c)'s document name; its Main opens with no `#` title. */
export const OLDER_TITLE = "Example intake pilot proposal";

/**
 * Fixture (c)'s first figure: a top-down chain of twelve short steps, as a
 * document from before figure lines holds it, which the engine would draw
 * taller than a printed figure may be; it draws as a grid of numbered
 * steps. Its first and last labels print nowhere else.
 */
export const OLDER_TALL_CHAIN = [
	"Intake desk",
	"Triage",
	"Assign owner",
	"Draft plan",
	"Review plan",
	"Approve",
	"Build",
	"Verify",
	"Stage",
	"Release",
	"Monitor",
	"Archive the case",
] as const;

/**
 * Fixture (c)'s second figure: a sideways chain of labels under 40
 * characters, two of them dense in dashes, m, w and hyphens, which Inter
 * draws wider than the engine's estimate by more than their boxes' padding,
 * between two ordinary ones, which fit.
 */
export const OLDER_DENSE_LABELS = [
	"Momentum — minimum-time multi-team flow",
	"Discovery workshop with the client team",
	"Mid-term metrics — maximum momentum",
	"Review the proposal with stakeholders",
] as const;

/** How many figures fixture (c) numbers. */
export const OLDER_FIGURE_COUNT = 2;

/**
 * Fixture (c), shaped like an older Main: its diagrams are plain Mermaid
 * fences without a figure line, one tall and one with dense labels.
 */
export const OLDER_PROPOSAL = sectionsMarkdown([
	{
		heading: "1. How a request moves",
		subtitle: null,
		body: [
			PARAGRAPH,
			fence(
				"%% caption: Every step a request takes",
				"flowchart TD",
				...OLDER_TALL_CHAIN.slice(1).map(
					(label, index) =>
						`  s${index}["${OLDER_TALL_CHAIN[index]}"] --> s${index + 1}["${label}"]`,
				),
			),
			PARAGRAPH,
		],
	},
	{
		heading: "2. How the teams work",
		subtitle: null,
		body: [
			PARAGRAPH,
			fence(
				"%% caption: Four ways of working",
				"flowchart LR",
				...OLDER_DENSE_LABELS.slice(1).map(
					(label, index) =>
						`  d${index}["${OLDER_DENSE_LABELS[index]}"] --> d${index + 1}["${label}"]`,
				),
			),
			PARAGRAPH,
		],
	},
]).join("\n\n");

/** Fixture (d)'s document name. */
export const LONG_OPENER_TITLE = "Example request flow proposal";

/** Fixture (d)'s heading as typed: three lines in the opener. */
export const LONG_OPENER_HEADING =
	"1. How the pilot moves every request from the first interview with dispatch to the measured review of cost and adoption";

/** Exactly the longest subtitle an opener takes (200 characters). */
export const LONG_OPENER_SUBTITLE =
	"Every request the crews raise moves through the same twenty steps, from the intake desk to the archive, so the closing review can compare the pilot region with the baseline on cost and response times.";

/**
 * Fixture (d)'s figure: a top-down chain of twenty steps, which the engine
 * would draw taller than a printed figure may be; it draws as a grid of
 * numbered steps. Its first and last labels print nowhere else.
 */
export const LONG_OPENER_CHAIN = [
	"Open the request",
	...Array.from({ length: 18 }, (_, index) => `Step ${index + 2}`),
	"Close the request",
] as const;

/**
 * Fixture (d): the long opener and the chain right under it, then one
 * short paragraph.
 */
export const LONG_OPENER_PROPOSAL = sectionsMarkdown([
	{
		heading: LONG_OPENER_HEADING,
		subtitle: LONG_OPENER_SUBTITLE,
		body: [
			fence(
				"%% caption: Every step a request takes",
				"flowchart TD",
				...LONG_OPENER_CHAIN.slice(1).map(
					(label, index) =>
						`  c${index}["${LONG_OPENER_CHAIN[index]}"] --> c${index + 1}["${label}"]`,
				),
			),
			"The pilot keeps every step and only changes who acts on it.",
		],
	},
]).join("\n\n");

/** Fixture (e)'s document name. */
export const BRANCHED_OPENER_TITLE = "Example request routing proposal";

/** Fixture (e)'s heading as typed: one line in the opener. */
export const BRANCHED_OPENER_HEADING = "1. How a request is routed";

/** Fixture (e)'s subtitle: one line in the opener. */
export const BRANCHED_OPENER_SUBTITLE = "Two routes, one review.";

/**
 * Fixture (e)'s figure: nine ranks top-down, with a branch after the second
 * step and a join after the third, 735 px as drawn: its labels would reach
 * the print floor at 679 px, more than the 600 px the opener leaves. Its
 * first and last labels print nowhere else.
 */
export const BRANCHED_OPENER_FLOW = [
	"Request received",
	"Check the details",
	"Route to dispatch",
	"Route to a crew lead",
	"Schedule the visit",
	"Visit the site",
	"Record the work",
	"Review the record",
	"Invoice the client",
	"Close the request",
] as const;

/** The paragraph after fixture (e)'s figure. */
export const BRANCHED_OPENER_AFTER =
	"Both routes meet at the schedule, so the review compares them on one footing.";

/**
 * Fixture (e): the opener and the branched flowchart right under it, then
 * one short paragraph.
 */
export const BRANCHED_OPENER_PROPOSAL = sectionsMarkdown([
	{
		heading: BRANCHED_OPENER_HEADING,
		subtitle: BRANCHED_OPENER_SUBTITLE,
		body: [
			fence(
				"%% caption: How a request is routed",
				"flowchart TD",
				`  a["${BRANCHED_OPENER_FLOW[0]}"] --> b["${BRANCHED_OPENER_FLOW[1]}"]`,
				`  b --> c["${BRANCHED_OPENER_FLOW[2]}"]`,
				`  b --> d["${BRANCHED_OPENER_FLOW[3]}"]`,
				`  c --> e["${BRANCHED_OPENER_FLOW[4]}"]`,
				"  d --> e",
				`  e --> f["${BRANCHED_OPENER_FLOW[5]}"]`,
				`  f --> g["${BRANCHED_OPENER_FLOW[6]}"]`,
				`  g --> h["${BRANCHED_OPENER_FLOW[7]}"]`,
				`  h --> i["${BRANCHED_OPENER_FLOW[8]}"]`,
				`  i --> j["${BRANCHED_OPENER_FLOW[9]}"]`,
			),
			BRANCHED_OPENER_AFTER,
		],
	},
]).join("\n\n");

/** Fixture (f)'s document name. */
export const SHRUNK_OPENER_TITLE = "Example crew routing proposal";

/**
 * Fixture (f)'s heading as typed: three lines in the opener, so the room
 * under it is less than an opener with a one-line heading leaves.
 */
export const SHRUNK_OPENER_HEADING =
	"1. How a request is routed from the first call to the closing review of cost and adoption in the pilot";

/** Fixture (f)'s subtitle: one line in the opener. */
export const SHRUNK_OPENER_SUBTITLE = "Two routes, one review.";

/**
 * Fixture (f)'s figure: seven ranks top-down, with a branch after the
 * second step and a join after the third, a little taller than the room
 * its opener leaves, where its labels still print above the floor. Its
 * first and last labels print nowhere else.
 */
export const SHRUNK_OPENER_FLOW = [
	"Request logged",
	"Check the caller",
	"Send to dispatch",
	"Send to a crew lead",
	"Book the visit",
	"Do the work",
	"Sign off the job",
	"Archive the job",
] as const;

/** The paragraph after fixture (f)'s figure. */
export const SHRUNK_OPENER_AFTER =
	"Both routes meet at the booking, so the review weighs them alike.";

/**
 * Fixture (f): the long opener and the branched flowchart right under it,
 * then one short paragraph.
 */
export const SHRUNK_OPENER_PROPOSAL = sectionsMarkdown([
	{
		heading: SHRUNK_OPENER_HEADING,
		subtitle: SHRUNK_OPENER_SUBTITLE,
		body: [
			fence(
				"%% caption: How a call is routed",
				"flowchart TD",
				`  a["${SHRUNK_OPENER_FLOW[0]}"] --> b["${SHRUNK_OPENER_FLOW[1]}"]`,
				`  b --> c["${SHRUNK_OPENER_FLOW[2]}"]`,
				`  b --> d["${SHRUNK_OPENER_FLOW[3]}"]`,
				`  c --> e["${SHRUNK_OPENER_FLOW[4]}"]`,
				"  d --> e",
				`  e --> f["${SHRUNK_OPENER_FLOW[5]}"]`,
				`  f --> g["${SHRUNK_OPENER_FLOW[6]}"]`,
				`  g --> h["${SHRUNK_OPENER_FLOW[7]}"]`,
			),
			SHRUNK_OPENER_AFTER,
		],
	},
]).join("\n\n");
