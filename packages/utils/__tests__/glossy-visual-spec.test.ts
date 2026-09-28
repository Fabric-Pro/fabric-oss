import { describe, expect, it } from "vitest";
import {
	type VisualSpec,
	specHash,
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
