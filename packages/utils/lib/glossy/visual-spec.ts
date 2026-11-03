/**
 * Typed visual specs for Glossy editions (Fizzy #2589, R17, R19, R20, KTD15).
 *
 * A Glossy build detects visual opportunities across six kinds — timeline,
 * comparison, stat, flow, org chart, and existing Mermaid — and stores each
 * as one of these typed specs rather than as rendered pixels or raw diagram
 * source (KTD15: "visuals are stored as specs and rendered in the
 * browser"). `auto` is a seventh discriminant used only by a slot that has
 * not yet been resolved to a concrete kind (U6); it never reaches the
 * templates in `visual-templates.ts`.
 *
 * A Proposal's visuals step (Fizzy #2946) also extracts two kinds Glossy
 * never does, architecture layers and a team, which the Proposal's figure
 * templates draw. They live in `proposalVisualSpecSchema` only, so every
 * Glossy validator (`visualSpecSchema`) still refuses them.
 *
 * No Node built-ins: the editor and web bundles import this module (via a
 * visual slot's stored spec), so it must stay browser-safe, same rule as
 * `eligibility.ts` and `outline.ts` in this directory.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared text bounds ("item and label bounds")
// ---------------------------------------------------------------------------

/** A short label: a title, a node/step name, a stat caption. */
const shortLabel = z.string().trim().min(1).max(60);
/** A longer label: a comparison bullet, a timeline event, a node label. */
const mediumLabel = z.string().trim().min(1).max(120);
/** Free-form supporting prose attached to an item (a description, a bullet body). */
const longText = z.string().trim().min(1).max(240);
/** A stat's headline figure — short by design, e.g. "42%", "$1.2M", "15". */
const statValue = z.string().trim().min(1).max(24);
/** An internal node identifier (org chart nodes reference each other by this). */
const nodeId = z.string().trim().min(1).max(40);

// ---------------------------------------------------------------------------
// Per-kind schemas
// ---------------------------------------------------------------------------

const timelineItemSchema = z.object({
	/** When the event happens — often a quarter or date, sometimes a phase name. */
	date: shortLabel,
	label: mediumLabel,
	description: longText.optional(),
});

const timelineSpecSchema = z.object({
	kind: z.literal("timeline"),
	title: shortLabel.optional(),
	items: z.array(timelineItemSchema).min(2).max(8),
});

const comparisonItemSchema = z.object({
	title: shortLabel,
	points: z.array(mediumLabel).min(1).max(6),
});

const comparisonSpecSchema = z.object({
	kind: z.literal("comparison"),
	title: shortLabel.optional(),
	items: z.array(comparisonItemSchema).min(2).max(4),
});

const statItemSchema = z.object({
	value: statValue,
	label: mediumLabel,
});

const statSpecSchema = z.object({
	kind: z.literal("stat"),
	title: shortLabel.optional(),
	items: z.array(statItemSchema).min(1).max(4),
});

const flowStepSchema = z.object({
	label: mediumLabel,
	description: longText.optional(),
	/** Who performs the step — a team, role, or person the section names.
	 * Optional so specs stored before swimlanes still parse; the flow draws
	 * swimlanes only when every step has one and there are at least two
	 * (see `flowToMermaid`). */
	lane: shortLabel.optional(),
});

const flowSpecSchema = z.object({
	kind: z.literal("flow"),
	title: shortLabel.optional(),
	steps: z.array(flowStepSchema).min(2).max(8),
});

const orgChartNodeSchema = z.object({
	id: nodeId,
	label: mediumLabel,
	/** `null` marks the chart's single root. Every other node's parent must
	 * reference another node's `id` in the same spec (enforced below, since
	 * zod's per-object validation cannot see sibling array entries). */
	parentId: nodeId.nullable(),
});

const orgChartSpecSchema = z.object({
	kind: z.literal("org_chart"),
	title: shortLabel.optional(),
	nodes: z.array(orgChartNodeSchema).min(2).max(16),
});

const existingMermaidSpecSchema = z.object({
	kind: z.literal("existing_mermaid"),
	title: shortLabel.optional(),
	/** Raw Mermaid source as found in the document (R19: restyled, not regenerated). */
	source: z.string().trim().min(1).max(20_000),
});

const autoSpecSchema = z.object({
	kind: z.literal("auto"),
	/** Free-text detection hint carried by a slot before it resolves to a concrete kind. */
	hint: z.string().trim().min(1).max(300).optional(),
});

// ---------------------------------------------------------------------------
// Proposal-only kinds (Fizzy #2946)
// ---------------------------------------------------------------------------

/** The most layers, and components per layer, the layers figure draws legibly. */
const LAYERS_MAX_LAYERS = 8;
const LAYERS_MAX_COMPONENTS = 5;
/** The most people on one side of the team figure. */
const TEAM_MAX_MEMBERS = 10;

const layerSchema = z.object({
	/** The layer's name, drawn as its row heading. */
	name: shortLabel,
	/** What the layer is for, drawn under its name. */
	description: mediumLabel.optional(),
	/** The layer's components, left to right. */
	components: z.array(mediumLabel).min(1).max(LAYERS_MAX_COMPONENTS),
});

const crosscuttingSchema = z.object({
	/** What runs across every layer, e.g. security; drawn as a side column. */
	name: shortLabel,
	description: mediumLabel.optional(),
	items: z.array(mediumLabel).min(1).max(6),
});

const layersSpecSchema = z.object({
	kind: z.literal("layers"),
	title: shortLabel.optional(),
	/** Top to bottom. */
	layers: z.array(layerSchema).min(2).max(LAYERS_MAX_LAYERS),
	crosscutting: crosscuttingSchema.optional(),
});

const teamMemberSchema = z.object({
	role: mediumLabel,
	/** The person's name, only when the section gives it. */
	name: shortLabel.optional(),
	description: longText.optional(),
});

const teamSideSchema = z.object({
	/** The team or organization, as the section names it. */
	name: shortLabel,
	description: mediumLabel.optional(),
	members: z.array(teamMemberSchema).min(1).max(TEAM_MAX_MEMBERS),
});

const teamSpecSchema = z.object({
	kind: z.literal("team"),
	title: shortLabel.optional(),
	/** The team the proposal offers, drawn on the left. */
	proposer: teamSideSchema,
	/** The client's own people, drawn on the right. */
	client: teamSideSchema,
	/** One forum or rhythm both sides take part in, drawn between them. */
	shared: mediumLabel.optional(),
});

// ---------------------------------------------------------------------------
// Org chart tree validation (cycle + parent-reference checks)
// ---------------------------------------------------------------------------

/**
 * Walk every node's parent chain looking for a repeat — a node that is its
 * own ancestor. Assumes `nodes` ids are already known unique and every
 * `parentId` already known to reference a real node (checked before this
 * runs), so the only remaining failure mode is a cycle.
 */
function hasOrgChartCycle(
	nodes: ReadonlyArray<{ id: string; parentId: string | null }>,
): boolean {
	const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
	for (const start of nodes) {
		const visited = new Set<string>();
		let current: string | null = start.id;
		while (current !== null) {
			if (visited.has(current)) {
				return true;
			}
			visited.add(current);
			current = parentOf.get(current) ?? null;
		}
	}
	return false;
}

function validateOrgChartTree(
	nodes: ReadonlyArray<{
		id: string;
		label: string;
		parentId: string | null;
	}>,
	ctx: z.RefinementCtx,
): void {
	const ids = new Set<string>();
	for (const node of nodes) {
		if (ids.has(node.id)) {
			ctx.addIssue({
				code: "custom",
				path: ["nodes"],
				message: `Duplicate org chart node id "${node.id}".`,
			});
			return;
		}
		ids.add(node.id);
	}

	let rootCount = 0;
	for (const node of nodes) {
		if (node.parentId === null) {
			rootCount++;
			continue;
		}
		if (!ids.has(node.parentId)) {
			ctx.addIssue({
				code: "custom",
				path: ["nodes"],
				message: `Org chart node "${node.id}" has an unknown parent "${node.parentId}".`,
			});
			return;
		}
	}
	if (rootCount !== 1) {
		ctx.addIssue({
			code: "custom",
			path: ["nodes"],
			message: `An org chart must have exactly one root node (parentId: null); found ${rootCount}.`,
		});
		return;
	}

	if (hasOrgChartCycle(nodes)) {
		ctx.addIssue({
			code: "custom",
			path: ["nodes"],
			message: "Org chart nodes contain a cycle.",
		});
	}
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const visualSpecSchema = z
	.discriminatedUnion("kind", [
		timelineSpecSchema,
		comparisonSpecSchema,
		statSpecSchema,
		flowSpecSchema,
		orgChartSpecSchema,
		existingMermaidSpecSchema,
		autoSpecSchema,
	])
	.superRefine((spec, ctx) => {
		if (spec.kind === "org_chart") {
			validateOrgChartTree(spec.nodes, ctx);
		}
	});

export type VisualSpec = z.infer<typeof visualSpecSchema>;
export type VisualKind = VisualSpec["kind"];

export type TimelineVisualSpec = z.infer<typeof timelineSpecSchema>;
export type ComparisonVisualSpec = z.infer<typeof comparisonSpecSchema>;
export type StatVisualSpec = z.infer<typeof statSpecSchema>;
export type FlowVisualSpec = z.infer<typeof flowSpecSchema>;
export type OrgChartVisualSpec = z.infer<typeof orgChartSpecSchema>;
export type ExistingMermaidVisualSpec = z.infer<
	typeof existingMermaidSpecSchema
>;
export type AutoVisualSpec = z.infer<typeof autoSpecSchema>;

/** The seven discriminant values `visualSpecSchema` accepts, `auto` last (it is slot-only). */
export const VISUAL_KINDS = [
	"timeline",
	"comparison",
	"stat",
	"flow",
	"org_chart",
	"existing_mermaid",
	"auto",
] as const satisfies readonly VisualKind[];

/**
 * Every Glossy kind plus the Proposal-only ones (Fizzy #2946). For a
 * Proposal's visuals step and Edit with instructions only: Glossy validates
 * with `visualSpecSchema`, which refuses `layers` and `team`.
 */
export const proposalVisualSpecSchema = z
	.discriminatedUnion("kind", [
		timelineSpecSchema,
		comparisonSpecSchema,
		statSpecSchema,
		flowSpecSchema,
		orgChartSpecSchema,
		existingMermaidSpecSchema,
		autoSpecSchema,
		layersSpecSchema,
		teamSpecSchema,
	])
	.superRefine((spec, ctx) => {
		if (spec.kind === "org_chart") {
			validateOrgChartTree(spec.nodes, ctx);
		}
	});

export type ProposalVisualSpec = z.infer<typeof proposalVisualSpecSchema>;
export type ProposalVisualKind = ProposalVisualSpec["kind"];
export type LayersVisualSpec = z.infer<typeof layersSpecSchema>;
export type TeamVisualSpec = z.infer<typeof teamSpecSchema>;

/** The kinds only a Proposal extracts, drawn by its layers and team figure templates. */
export const PROPOSAL_ONLY_VISUAL_KINDS = [
	"layers",
	"team",
] as const satisfies readonly Exclude<ProposalVisualKind, VisualKind>[];
export type ProposalOnlyVisualKind =
	(typeof PROPOSAL_ONLY_VISUAL_KINDS)[number];

// ---------------------------------------------------------------------------
// Proposal-only spec rules (Fizzy #2946)
// ---------------------------------------------------------------------------

/**
 * The longest date a Proposal timeline entry may show: two lines of its
 * figure's date line at most. The extraction prompt quotes the same bound.
 */
export const PROPOSAL_TIMELINE_DATE_MAX_CHARS = 20;

/**
 * Units of time, English and German, that make a number a period: "Week 1",
 * "First 30 days", "2. Halbjahr", "Nach 3 Monaten".
 */
const PERIOD_UNITS = new Set(
	"day days week weeks wk wks month months mo mos quarter quarters qtr half halves year years yr yrs sprint sprints cw tag tage tagen woche wochen monat monate monaten quartal quartale quartalen halbjahr halbjahre jahr jahre jahren kw".split(
		" ",
	),
);

/**
 * Month and season names, and the months' abbreviations, English and
 * German: each says when by itself ("March", "Summer 2026", "Herbst").
 */
const PERIOD_MONTHS = new Set(
	"january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec januar jänner februar märz mai juni juli oktober dezember mär okt dez spring summer fall autumn winter frühjahr frühling sommer herbst".split(
		" ",
	),
);

/**
 * Words that place or join periods: "Mid-2026", "End of Q2", "First 30
 * days", "Within 2 weeks", "Ende 2026", "vom 1. bis 5. März".
 */
const PERIOD_QUALIFIERS = new Set(
	"early mid late end start beginning by from to until through and of before after first next last within anfang mitte ende von vom bis ab und erste ersten nach innerhalb".split(
		" ",
	),
);

/**
 * A token that is a date or period by itself: a year, a quarter or half, a
 * fiscal year, a calendar week, a week or month in short ("W1", "M3"), or
 * a numeric date.
 */
const PERIOD_TOKEN =
	/^(?:(?:19|20)\d{2}|q[1-4]|h[12]|fy\d{2}(?:\d{2})?|[ck]w\d{1,2}|[wm]\d{1,2}|\d{1,4}[./]\d{1,2}(?:[./]\d{1,4})?\.?)$/u;

/** A count or position: "2", "2nd", "1." (a German ordinal). */
const PERIOD_NUMBER = /^\d{1,3}(?:st|nd|rd|th|\.)?$/u;

/**
 * Whether `date` is what a Proposal timeline entry's date line may show: a
 * short date or period ("Week 1", "Weeks 2–5", "Q3 2026", "Month 2",
 * "March", "Summer 2026", "W1–W4") of at most
 * `PROPOSAL_TIMELINE_DATE_MAX_CHARS`. Every word must be a unit of time, a
 * month or season, a placing word, a number or a date token, and one of
 * them must say when: a date token, a month or season, or a unit with a
 * number. A phase name ("Phase 1"), a step or a sentence is not a period,
 * so a timeline built from undated stages fails here and is not drawn.
 */
export function isProposalTimelinePeriod(date: string): boolean {
	const trimmed = date.trim();
	if (
		trimmed === "" ||
		Array.from(trimmed).length > PROPOSAL_TIMELINE_DATE_MAX_CHARS
	) {
		return false;
	}
	// ISO dates split at their hyphens into a year and two numbers; "FY"
	// joins the year after it, as "FY2027" is written.
	const tokens = trimmed
		.toLowerCase()
		.replace(/\bfy\s+(?=\d)/gu, "fy")
		.split(/[\s,()–—\-/+&]+/u)
		.filter((token) => token !== "");
	let anchored = false;
	let unit = false;
	let number = false;
	for (const token of tokens) {
		if (
			PERIOD_TOKEN.test(token) ||
			PERIOD_MONTHS.has(token.replace(/\.$/u, ""))
		) {
			anchored = true;
		} else if (PERIOD_UNITS.has(token)) {
			unit = true;
		} else if (PERIOD_NUMBER.test(token)) {
			number = true;
		} else if (!PERIOD_QUALIFIERS.has(token)) {
			return false;
		}
	}
	return anchored || (unit && number);
}

/**
 * A comparison as a Proposal's table shows it (Fizzy #2946), or null when
 * its columns are too uneven to read as one: any option with fewer than two
 * points, or the shortest with fewer than half the points of the longest.
 * A kept comparison keeps each option's first points down to the
 * second-longest column's count, so no row of the table is filled in one
 * column only; with two options every row is filled in both.
 */
export function balancedProposalComparison(
	spec: ComparisonVisualSpec,
): ComparisonVisualSpec | null {
	const counts = spec.items.map((item) => item.points.length);
	const shortest = Math.min(...counts);
	const longest = Math.max(...counts);
	if (shortest < 2 || shortest * 2 < longest) {
		return null;
	}
	const rows = [...counts].sort((a, b) => b - a)[1] ?? longest;
	if (rows === longest) {
		return spec;
	}
	return {
		...spec,
		items: spec.items.map((item) => ({
			...item,
			points: item.points.slice(0, rows),
		})),
	};
}

// ---------------------------------------------------------------------------
// Fact extraction (feeds U4's checkVisualFacts, KTD12)
// ---------------------------------------------------------------------------

export interface VisualSpecFacts {
	kind: ProposalVisualKind;
	/** Every distinct piece of visible text the visual displays, in spec order. */
	labels: string[];
	/** Distinct numeric/quantitative substrings found anywhere in that text
	 * (currency, percentages, plain counts) — what the fact guard cross-checks
	 * against the source section for fabricated numbers. */
	figures: string[];
}

/**
 * A number-like token: an optional currency sigil, digits (with optional
 * thousands commas and a decimal part), an optional trailing `%`, and an
 * optional attached magnitude letter (`5k`, `1.2M`). Guarded on both sides
 * by a negative lookaround for a letter or digit so an ordinal-ish token
 * such as "Q1" or a version like "v2" does not yield a spurious "1" or "2" —
 * the leading letter blocks the match starting at the digit.
 */
const FIGURE_PATTERN =
	/(?<![\p{L}\d])[$€£]?\d[\d,]*(?:\.\d+)?%?(?:\s?[kKmMbB])?(?![\p{L}\d])/gu;

function extractFigures(text: string): string[] {
	return text.match(FIGURE_PATTERN) ?? [];
}

/** Insertion-order dedupe (a `Set` preserves first-seen order on iteration). */
function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

/**
 * Flatten a visual spec into the plain text it displays and the figures
 * within that text, for U4's fact guard (KTD12's presence, hedge, and
 * must-keep checks; R20's structural checks apply to `existing_mermaid`
 * separately since it is restyled, not fact-checked prose).
 *
 * Every text-bearing field (including a stat's `value` or a timeline's
 * `date`) is both a label — it must be traceable to something the source
 * document actually says — and a source of figures, since a date or a value
 * field is exactly where a fabricated number is most likely to hide.
 */
export function visualSpecFacts(spec: ProposalVisualSpec): VisualSpecFacts {
	const labels: string[] = [];

	const addLabel = (value: string | undefined | null) => {
		const trimmed = value?.trim();
		if (trimmed) {
			labels.push(trimmed);
		}
	};

	switch (spec.kind) {
		case "timeline":
			addLabel(spec.title);
			for (const item of spec.items) {
				addLabel(item.date);
				addLabel(item.label);
				addLabel(item.description);
			}
			break;
		case "comparison":
			addLabel(spec.title);
			for (const item of spec.items) {
				addLabel(item.title);
				for (const point of item.points) {
					addLabel(point);
				}
			}
			break;
		case "stat":
			addLabel(spec.title);
			for (const item of spec.items) {
				addLabel(item.value);
				addLabel(item.label);
			}
			break;
		case "flow":
			addLabel(spec.title);
			// Lanes first, in first-appearance order, so they lead the alt text
			// like the headings they are. Every lane is checked, including one
			// on a flow that falls back to a plain chain: it is a stored
			// display field, so it must be traceable like the org chart's names.
			for (const step of spec.steps) {
				addLabel(step.lane);
			}
			for (const step of spec.steps) {
				addLabel(step.label);
				addLabel(step.description);
			}
			break;
		case "org_chart":
			addLabel(spec.title);
			for (const node of spec.nodes) {
				addLabel(node.label);
			}
			break;
		case "existing_mermaid":
			addLabel(spec.title);
			// The Mermaid source itself is diagram syntax, not prose the fact
			// guard should scan for claims.
			break;
		case "auto":
			addLabel(spec.hint);
			break;
		case "layers":
			addLabel(spec.title);
			for (const layer of spec.layers) {
				addLabel(layer.name);
				addLabel(layer.description);
				for (const component of layer.components) {
					addLabel(component);
				}
			}
			if (spec.crosscutting) {
				addLabel(spec.crosscutting.name);
				addLabel(spec.crosscutting.description);
				for (const item of spec.crosscutting.items) {
					addLabel(item);
				}
			}
			break;
		case "team":
			addLabel(spec.title);
			for (const side of [spec.proposer, spec.client]) {
				addLabel(side.name);
				addLabel(side.description);
				for (const member of side.members) {
					addLabel(member.role);
					addLabel(member.name);
					addLabel(member.description);
				}
			}
			addLabel(spec.shared);
			break;
	}

	const distinctLabels = dedupe(labels);
	return {
		kind: spec.kind,
		labels: distinctLabels,
		figures: dedupe(distinctLabels.flatMap(extractFigures)),
	};
}

// ---------------------------------------------------------------------------
// specHash — pure, non-cryptographic cache/memo key
// ---------------------------------------------------------------------------

/**
 * Canonical (key-sorted) JSON encoding, so two specs with the same content
 * but different key insertion order (e.g. one round-tripped through a model
 * response, one built directly) hash identically.
 */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
	return `{${entries.join(",")}}`;
}

/** 32-bit FNV-1a over a string, seeded so two calls with different seeds diverge. */
export function fnv1a(value: string, seed: number): number {
	let hash = seed;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export const FNV_OFFSET_BASIS = 0x811c9dc5;
/** Golden-ratio constant, used only to decorrelate the second FNV-1a pass from the first. */
export const SECOND_SEED = 0x9e3779b9;

/**
 * Stable, non-cryptographic hash of a visual spec's content, for cache and
 * memo keys (distinct from `GLOSSY_PIPELINE_VERSION`, KTD14, which covers
 * prompt/version drift, not spec content). Implemented as a pure two-pass
 * FNV-1a over a canonical encoding rather than with `node:crypto`, because
 * this module is imported by the browser bundle — see the module header.
 *
 * Sixteen hex characters (two independent 32-bit halves). Not
 * collision-resistant enough for anything security-sensitive; this is a
 * cache key, never an identity or integrity check.
 */
export function specHash(spec: VisualSpec): string {
	const canonical = canonicalize(spec);
	const low = fnv1a(canonical, FNV_OFFSET_BASIS)
		.toString(16)
		.padStart(8, "0");
	const high = fnv1a(canonical, SECOND_SEED).toString(16).padStart(8, "0");
	return `${low}${high}`;
}
