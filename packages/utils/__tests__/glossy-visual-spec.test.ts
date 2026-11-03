import { describe, expect, it } from "vitest";
import {
	balancedProposalComparison,
	type ComparisonVisualSpec,
	isProposalTimelinePeriod,
	type LayersVisualSpec,
	PROPOSAL_ONLY_VISUAL_KINDS,
	PROPOSAL_TIMELINE_DATE_MAX_CHARS,
	proposalVisualSpecSchema,
	specHash,
	type TeamVisualSpec,
	type VisualSpec,
	visualSpecFacts,
	visualSpecSchema,
} from "../lib/glossy/visual-spec";

const validTimeline: VisualSpec = {
	kind: "timeline",
	title: "Rollout plan",
	items: [
		{
			date: "Q1 2026",
			label: "Pilot launch",
			description: "3 design partners",
		},
		{ date: "Q2 2026", label: "General availability" },
	],
};

const validComparison: VisualSpec = {
	kind: "comparison",
	title: "Build vs buy",
	items: [
		{ title: "Build", points: ["Full control", "6 month timeline"] },
		{ title: "Buy", points: ["Faster to ship", "$50,000 per year"] },
	],
};

const validStat: VisualSpec = {
	kind: "stat",
	items: [{ value: "42%", label: "Support ticket reduction" }],
};

const validFlow: VisualSpec = {
	kind: "flow",
	steps: [
		{ label: "Submit request" },
		{ label: "Review" },
		{ label: "Approve" },
	],
};

const validOrgChart: VisualSpec = {
	kind: "org_chart",
	nodes: [
		{ id: "ceo", label: "CEO", parentId: null },
		{ id: "cto", label: "CTO", parentId: "ceo" },
		{ id: "eng", label: "Engineering Lead", parentId: "cto" },
	],
};

const validExistingMermaid: VisualSpec = {
	kind: "existing_mermaid",
	source: "flowchart TD\nA-->B",
};

const validAuto: VisualSpec = {
	kind: "auto",
	hint: "A chart showing adoption over time",
};

describe("visualSpecSchema", () => {
	it("accepts a minimal valid spec of every kind", () => {
		for (const spec of [
			validTimeline,
			validComparison,
			validStat,
			validFlow,
			validOrgChart,
			validExistingMermaid,
			validAuto,
		]) {
			expect(visualSpecSchema.safeParse(spec).success).toBe(true);
		}
	});

	it("rejects a timeline with only one item (below the 2-item bound)", () => {
		const result = visualSpecSchema.safeParse({
			kind: "timeline",
			items: [{ date: "Q1", label: "Only item" }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a timeline over the 8-item bound", () => {
		const items = Array.from({ length: 9 }, (_, i) => ({
			date: `Q${(i % 4) + 1}`,
			label: `Item ${i}`,
		}));
		const result = visualSpecSchema.safeParse({ kind: "timeline", items });
		expect(result.success).toBe(false);
	});

	it("rejects a comparison item over the 4-item bound", () => {
		const items = Array.from({ length: 5 }, (_, i) => ({
			title: `Option ${i}`,
			points: ["A point"],
		}));
		const result = visualSpecSchema.safeParse({
			kind: "comparison",
			items,
		});
		expect(result.success).toBe(false);
	});

	it("rejects a stat with an empty items array (below the 1-item bound)", () => {
		const result = visualSpecSchema.safeParse({ kind: "stat", items: [] });
		expect(result.success).toBe(false);
	});

	it("rejects a stat value over its length bound", () => {
		const result = visualSpecSchema.safeParse({
			kind: "stat",
			items: [{ value: "1".repeat(25), label: "Too long" }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a flow with only one step (below the 2-step bound)", () => {
		const result = visualSpecSchema.safeParse({
			kind: "flow",
			steps: [{ label: "Only step" }],
		});
		expect(result.success).toBe(false);
	});

	it("parses a stored flow spec without lanes unchanged", () => {
		const stored = JSON.parse(JSON.stringify(validFlow));
		const result = visualSpecSchema.safeParse(stored);
		expect(result.success).toBe(true);
		expect(result.data).toStrictEqual(validFlow);
	});

	it("accepts a lane on each flow step, bounded like other short labels", () => {
		const flow = (lane: string) => ({
			kind: "flow",
			steps: [
				{ label: "Submit request", lane },
				{ label: "Review", lane: "Legal" },
			],
		});
		expect(visualSpecSchema.safeParse(flow("Sales")).success).toBe(true);
		expect(visualSpecSchema.safeParse(flow("s".repeat(60))).success).toBe(
			true,
		);
		expect(visualSpecSchema.safeParse(flow("s".repeat(61))).success).toBe(
			false,
		);
		expect(visualSpecSchema.safeParse(flow("  ")).success).toBe(false);
	});

	it("rejects an org chart over the 16-node bound", () => {
		const nodes = [
			{ id: "root", label: "Root", parentId: null },
			...Array.from({ length: 16 }, (_, i) => ({
				id: `n${i}`,
				label: `Node ${i}`,
				parentId: "root",
			})),
		];
		const result = visualSpecSchema.safeParse({ kind: "org_chart", nodes });
		expect(result.success).toBe(false);
	});

	it("rejects an org chart with a cycle", () => {
		const result = visualSpecSchema.safeParse({
			kind: "org_chart",
			nodes: [
				{ id: "a", label: "A", parentId: "b" },
				{ id: "b", label: "B", parentId: "a" },
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects an org chart with an unknown parent reference", () => {
		const result = visualSpecSchema.safeParse({
			kind: "org_chart",
			nodes: [
				{ id: "a", label: "A", parentId: null },
				{ id: "b", label: "B", parentId: "ghost" },
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects an org chart with more than one root", () => {
		const result = visualSpecSchema.safeParse({
			kind: "org_chart",
			nodes: [
				{ id: "a", label: "A", parentId: null },
				{ id: "b", label: "B", parentId: null },
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects existing_mermaid with an empty source", () => {
		const result = visualSpecSchema.safeParse({
			kind: "existing_mermaid",
			source: "",
		});
		expect(result.success).toBe(false);
	});

	it("rejects an unknown kind", () => {
		const result = visualSpecSchema.safeParse({
			kind: "pie_chart",
			items: [],
		});
		expect(result.success).toBe(false);
	});
});

describe("visualSpecFacts", () => {
	it("returns exactly the labels and figures of a timeline spec", () => {
		expect(visualSpecFacts(validTimeline)).toEqual({
			kind: "timeline",
			labels: [
				"Rollout plan",
				"Q1 2026",
				"Pilot launch",
				"3 design partners",
				"Q2 2026",
				"General availability",
			],
			figures: ["2026", "3"],
		});
	});

	it("returns exactly the labels and figures of a comparison spec", () => {
		expect(visualSpecFacts(validComparison)).toEqual({
			kind: "comparison",
			labels: [
				"Build vs buy",
				"Build",
				"Full control",
				"6 month timeline",
				"Buy",
				"Faster to ship",
				"$50,000 per year",
			],
			figures: ["6", "$50,000"],
		});
	});

	it("returns exactly the labels and figures of a stat spec", () => {
		expect(visualSpecFacts(validStat)).toEqual({
			kind: "stat",
			labels: ["42%", "Support ticket reduction"],
			figures: ["42%"],
		});
	});

	it("deduplicates repeated labels and figures", () => {
		const spec: VisualSpec = {
			kind: "flow",
			steps: [{ label: "Review 50%" }, { label: "Review 50%" }],
		};
		expect(visualSpecFacts(spec)).toEqual({
			kind: "flow",
			labels: ["Review 50%"],
			figures: ["50%"],
		});
	});

	it("returns a flow's lanes first, once each, so they are fact-checked", () => {
		const spec: VisualSpec = {
			kind: "flow",
			title: "Order process",
			steps: [
				{ label: "Qualify lead", lane: "Sales" },
				{ label: "Review contract", lane: "Legal" },
				{ label: "Sign order", lane: "Sales" },
			],
		};
		expect(visualSpecFacts(spec).labels).toEqual([
			"Order process",
			"Sales",
			"Legal",
			"Qualify lead",
			"Review contract",
			"Sign order",
		]);
	});

	it("does not scan existing_mermaid source for labels or figures", () => {
		expect(visualSpecFacts(validExistingMermaid)).toEqual({
			kind: "existing_mermaid",
			labels: [],
			figures: [],
		});
	});

	it("does not mistake an ordinal like Q1 for a bare figure", () => {
		const spec: VisualSpec = {
			kind: "timeline",
			items: [
				{ date: "Q1", label: "Kickoff" },
				{ date: "Q2", label: "Launch" },
			],
		};
		expect(visualSpecFacts(spec).figures).toEqual([]);
	});
});

describe("specHash", () => {
	it("is stable across repeated calls on an identical spec", () => {
		expect(specHash(validStat)).toBe(specHash(validStat));
	});

	it("is the same regardless of object key order", () => {
		const items = validStat.kind === "stat" ? validStat.items : [];
		const reordered: VisualSpec = { items, kind: "stat" };
		expect(specHash(reordered)).toBe(specHash(validStat));
	});

	it("differs for specs with different content", () => {
		expect(specHash(validStat)).not.toBe(specHash(validFlow));
		expect(specHash(validTimeline)).not.toBe(specHash(validComparison));
	});

	it("changes only for flow specs that carry lanes", () => {
		// Pinned from before lanes existed: a stored flow keeps its hash.
		expect(specHash(visualSpecSchema.parse(validFlow))).toBe(
			"cc94671a699cd8ce",
		);
		const steps = validFlow.kind === "flow" ? validFlow.steps : [];
		const laned: VisualSpec = {
			kind: "flow",
			steps: steps.map((step, index) => ({
				...step,
				lane: index === 1 ? "Legal" : "Sales",
			})),
		};
		expect(specHash(laned)).not.toBe(specHash(validFlow));
	});

	it("returns a 16-character lowercase hex string", () => {
		expect(specHash(validOrgChart)).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("proposalVisualSpecSchema (Fizzy #2946)", () => {
	const layers: LayersVisualSpec = {
		kind: "layers",
		title: "Platform layers",
		layers: [
			{
				name: "Channels",
				description: "Where customers order",
				components: ["Web shop", "Mobile app"],
			},
			{ name: "Services", components: ["Orders", "Billing"] },
		],
		crosscutting: { name: "Operations", items: ["Monitoring"] },
	};

	const team: TeamVisualSpec = {
		kind: "team",
		proposer: {
			name: "Example Studio",
			members: [
				{ role: "Delivery lead", name: "Alex Example" },
				{ role: "Engineer", description: "Builds the services" },
			],
		},
		client: {
			name: "Example Retail",
			description: "Product side",
			members: [{ role: "Product owner" }],
		},
		shared: "Weekly steering meeting",
	};

	it("accepts layers and team, which Glossy's validator refuses", () => {
		for (const spec of [layers, team]) {
			expect(proposalVisualSpecSchema.safeParse(spec).success).toBe(true);
			expect(visualSpecSchema.safeParse(spec).success).toBe(false);
		}
		expect(PROPOSAL_ONLY_VISUAL_KINDS).toEqual(["layers", "team"]);
	});

	it("accepts every Glossy kind exactly as Glossy's validator does", () => {
		for (const spec of [
			validTimeline,
			validComparison,
			validStat,
			validFlow,
			validOrgChart,
			validExistingMermaid,
			validAuto,
		]) {
			expect(proposalVisualSpecSchema.parse(spec)).toEqual(
				visualSpecSchema.parse(spec),
			);
		}
		const cycle = {
			kind: "org_chart",
			nodes: [
				{ id: "a", label: "A", parentId: null },
				{ id: "b", label: "B", parentId: "c" },
				{ id: "c", label: "C", parentId: "b" },
			],
		};
		expect(proposalVisualSpecSchema.safeParse(cycle).success).toBe(false);
	});

	it("bounds layers to what the layers figure draws", () => {
		const layer = (components: number) => ({
			name: "Layer",
			components: Array.from(
				{ length: components },
				(_, index) => `Part ${index}`,
			),
		});
		const parses = (spec: Record<string, unknown>) =>
			proposalVisualSpecSchema.safeParse({ kind: "layers", ...spec })
				.success;

		expect(
			parses({ layers: Array.from({ length: 8 }, () => layer(5)) }),
		).toBe(true);
		expect(parses({ layers: [layer(1)] })).toBe(false);
		expect(
			parses({ layers: Array.from({ length: 9 }, () => layer(1)) }),
		).toBe(false);
		expect(parses({ layers: [layer(1), layer(6)] })).toBe(false);
		expect(parses({ layers: [layer(1), layer(0)] })).toBe(false);
		expect(
			parses({
				layers: [layer(1), layer(1)],
				crosscutting: { name: "Security", items: [] },
			}),
		).toBe(false);
	});

	it("bounds a team to two sides of 1–10 people", () => {
		const side = (members: number) => ({
			name: "Side",
			members: Array.from({ length: members }, (_, index) => ({
				role: `Role ${index}`,
			})),
		});
		const parses = (proposer: unknown, client: unknown) =>
			proposalVisualSpecSchema.safeParse({
				kind: "team",
				proposer,
				client,
			}).success;

		expect(parses(side(10), side(1))).toBe(true);
		expect(parses(side(11), side(1))).toBe(false);
		expect(parses(side(1), side(0))).toBe(false);
		expect(parses(side(1), undefined)).toBe(false);
	});

	it("lists every string a layers or team figure shows as a fact", () => {
		expect(visualSpecFacts(layers)).toEqual({
			kind: "layers",
			labels: [
				"Platform layers",
				"Channels",
				"Where customers order",
				"Web shop",
				"Mobile app",
				"Services",
				"Orders",
				"Billing",
				"Operations",
				"Monitoring",
			],
			figures: [],
		});
		expect(visualSpecFacts(team)).toEqual({
			kind: "team",
			labels: [
				"Example Studio",
				"Delivery lead",
				"Alex Example",
				"Engineer",
				"Builds the services",
				"Example Retail",
				"Product side",
				"Product owner",
				"Weekly steering meeting",
			],
			figures: [],
		});
	});
});

describe("isProposalTimelinePeriod (Fizzy #2946)", () => {
	it.each([
		"Week 1",
		"Weeks 2–5",
		"weeks 2-5",
		"Q3 2026",
		"Q3–Q4 2026",
		"H2 2026",
		"FY2027",
		"Month 2",
		"Months 1 to 3",
		"30 days",
		"Day 1",
		"Sprint 3",
		"Year 1",
		"March",
		"Mar 2026",
		"15 March 2026",
		"Mid-2026",
		"End of Q2",
		"By week 6",
		"2026",
		"2026-03-15",
		"15.03.2026",
		"KW 12",
		"Wochen 2–5",
		"März 2026",
		"Ende 2026",
		// Seasons, half-years and fiscal years.
		"Summer 2026",
		"Fall 2026",
		"Herbst 2026",
		"Frühjahr 2027",
		"First half 2027",
		"2. Halbjahr 2026",
		"FY 2027",
		"FY 27",
		// Weeks and months in short, and joined units.
		"W1–W4",
		"M1",
		"Week 1 & 2",
		// A period counted from the start.
		"First 30 days",
		"Next 90 days",
		"Within 2 weeks",
		"After 3 months",
		"Last 2 sprints",
		"Erste 30 Tage",
		"Nach 3 Monaten",
		"Innerhalb 2 Wochen",
		"vom 1. bis 5. März",
	])("accepts the date or period %j", (date) => {
		expect(isProposalTimelinePeriod(date)).toBe(true);
	});

	it.each([
		// A step or a phrase, as a model writes when the section dates nothing.
		"Map the current intake process",
		"Trial routing at two depots",
		"Kickoff",
		// A phase name is a stage, not a period.
		"Phase 1",
		"Discovery phase",
		// A unit without a number says no when.
		"Weeks",
		"Next month",
		"Now",
		"Ongoing",
		"TBD",
		"Weeks 2–5 (pilot)",
		// A placing word does not make a phrase a period.
		"Confirm scope",
		"Confirm scope and success criteria",
		"First workshop",
		"After kickoff",
		"Next steps",
		"Within scope",
		"Summer intern hiring",
		"FY",
		"Nach Abnahme",
		"Week 1 & review",
		"",
		"   ",
	])("refuses %j", (date) => {
		expect(isProposalTimelinePeriod(date)).toBe(false);
	});

	it("refuses a period longer than the date line holds", () => {
		const long = "Weeks 1 to 4 of Q3 2026";
		expect(Array.from(long).length).toBeGreaterThan(
			PROPOSAL_TIMELINE_DATE_MAX_CHARS,
		);
		expect(isProposalTimelinePeriod(long)).toBe(false);
		expect(PROPOSAL_TIMELINE_DATE_MAX_CHARS).toBe(20);
	});
});

describe("balancedProposalComparison (Fizzy #2946)", () => {
	const comparison = (...columns: number[]): ComparisonVisualSpec => ({
		kind: "comparison",
		items: columns.map((count, column) => ({
			title: `Option ${column + 1}`,
			points: Array.from(
				{ length: count },
				(_, row) => `Aspect ${row + 1} of option ${column + 1}`,
			),
		})),
	});
	const rows = (spec: ComparisonVisualSpec | null) =>
		spec?.items.map((item) => item.points.length) ?? null;

	it("refuses a column of fewer than two points", () => {
		expect(balancedProposalComparison(comparison(1, 1, 6))).toBeNull();
		expect(balancedProposalComparison(comparison(1, 1))).toBeNull();
		expect(balancedProposalComparison(comparison(3, 1, 3))).toBeNull();
	});

	it("refuses columns whose shortest has fewer than half the points of the longest", () => {
		expect(balancedProposalComparison(comparison(2, 5))).toBeNull();
		expect(balancedProposalComparison(comparison(6, 2, 6))).toBeNull();
	});

	it("keeps balanced columns as they are", () => {
		const spec = comparison(3, 3, 3);
		expect(balancedProposalComparison(spec)).toEqual(spec);
		expect(rows(balancedProposalComparison(comparison(2, 2)))).toEqual([
			2, 2,
		]);
	});

	it("leaves no row that only one column fills", () => {
		// Two columns: every row is filled in both.
		expect(rows(balancedProposalComparison(comparison(4, 2)))).toEqual([
			2, 2,
		]);
		// Three: a row past the second-longest column would hold one cell.
		expect(rows(balancedProposalComparison(comparison(4, 2, 2)))).toEqual([
			2, 2, 2,
		]);
		expect(rows(balancedProposalComparison(comparison(4, 3, 2)))).toEqual([
			3, 3, 2,
		]);
		expect(
			rows(balancedProposalComparison(comparison(6, 4, 3, 3))),
		).toEqual([4, 4, 3, 3]);
		// The points kept are each column's first, in order.
		expect(
			balancedProposalComparison(comparison(3, 2))?.items[0].points,
		).toEqual(["Aspect 1 of option 1", "Aspect 2 of option 1"]);
	});
});
