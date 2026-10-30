/**
 * Synthetic Proposals for the print e2e (`proposal-export-print.e2e.test.ts`).
 * Every name, figure and domain here is made up.
 *
 * - `FULL_PROPOSAL`: everything the print design draws. A cover lead of the
 *   longest length the cover takes and a three-tile key-figures block before
 *   the first H2; openers with italic subtitles; an id table, a callout and
 *   bold-led steps; hand-written process, timeline, layers and team figures;
 *   a plain Mermaid flowchart; a gantt (a kind only the live page draws, so a
 *   numbered placeholder); and a fence with a broken header (left out).
 * - `GENERATED_PROPOSAL`: shaped like a generated Main: no preamble, no
 *   subtitles, and process and timeline fences written by the real visual
 *   templating with their figure line, as generation writes them.
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

export const GENERATED_TITLE = "Field service pilot proposal";

/** Exactly the longest lead the cover takes (320 characters). */
export const COVER_LEAD =
	"Example Studio proposes a twelve-week pilot that moves Example Harbor Co dispatch and field crews from paper work orders to one shared mobile workflow, starting with the regional routes that carry the most repeat visits and ending with a measured review of cost, response time and crew adoption before any wider rollout.";

const PARAGRAPH =
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
export const FULL_FIGURE_COUNT = 6;

/** The figure-template fences of fixture (a), by their order among fences. */
export const FULL_TEMPLATE_FENCES = [0, 1, 2, 4];

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
	"gantt",
	"  title Pilot schedule",
	"  dateFormat YYYY-MM-DD",
	"  section Build",
	"  Routing :a1, 2026-11-02, 21d",
	"  Work orders :a2, after a1, 21d",
	"  section Pilot",
	"  Region one :b1, after a2, 28d",
);

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
];

function sectionsMarkdown(sections: readonly FixtureSection[]): string[] {
	return sections.flatMap((section) => [
		`## ${section.heading}`,
		...(section.subtitle ? [`*${section.subtitle}*`] : []),
		...section.body,
	]);
}

export const FULL_PROPOSAL = [
	COVER_LEAD,
	[
		"```stat-tiles",
		"Weeks to the pilot review: 12",
		"Crews in the pilot region: 40",
		"Fewer repeat visits targeted: 35%",
		"```",
	].join("\n"),
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

export const GENERATED_PROPOSAL =
	sectionsMarkdown(GENERATED_SECTIONS).join("\n\n");

/** How many figures fixture (b) numbers. */
export const GENERATED_FIGURE_COUNT = 2;
