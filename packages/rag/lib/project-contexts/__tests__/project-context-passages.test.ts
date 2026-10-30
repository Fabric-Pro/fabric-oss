import { beforeEach, expect, it, vi } from "vitest";
import { compactProjectContextPassages } from "../project-context-passages";
import type { RetrievedContext } from "../retrieval";

const h = vi.hoisted(() => ({ summary: vi.fn(), covered: vi.fn() }));
vi.mock("@repo/database", () => ({
	CONTEXT_SUMMARY_ENGINE_VERSION: 2,
	db: { projectContext: { findMany: h.covered } },
	getLatestCompletedContextSummary: h.summary,
	parseSummaryReferences: (refs: unknown) => refs,
	parseSourceSelection: () => ({ context: true }),
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isContextSummarizationEnabled: () => true,
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn() } }));

import { applyContextSummary } from "../summary-injection";

const render = (contexts: RetrievedContext[]) =>
	compactProjectContextPassages(contexts, "Search results", () => "");
beforeEach(() => vi.clearAllMocks());

it.each([
	[
		"page",
		{
			parentContextId: "source-parent",
			pageUrl: "https://example.com/plan",
		},
	],
	[
		"bundle",
		{ parentContextId: "source-parent", conversationBundleId: "bundle-1" },
	],
] as const)(
	"links a %s passage to its readable parent source",
	(kind, metadata) => {
		const result = render([
			{
				id: `${kind}-hit`,
				type: "LINK",
				score: 0.9,
				content: "Body",
				metadata,
				matchedPassages: [{ content: "Match", score: 0.9 }],
			},
		]);
		expect(result.context).toContain(
			'fabric_get_project_source({"source":"source-parent"})',
		);
		expect(result.context).not.toContain("cannot be read");
	},
);

it("labels an older-point fallback as the start of the document", () => {
	const result = render([
		{
			id: "source-old",
			type: "TEXT",
			score: 0.9,
			content: "Opening line\n".repeat(1000),
		},
	]);
	expect(result.context).toContain("start of the document");
	expect(result.context).not.toContain("Passages only");
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("keeps an injected summary's reference legend while extending ranked sources first", async () => {
	h.covered.mockResolvedValue([]);
	h.summary.mockResolvedValue({
		id: "summary-1",
		engineVersion: 2,
		content: `Summary [S1]\n${"Background detail\n".repeat(760)}`,
		references: [
			{
				marker: "S1",
				sourceType: "TEXT",
				sourceId: "source-reference",
				sourceTimestamp: "2026-10-01T00:00:00Z",
				label: "Launch decision",
			},
		],
		coveredThrough: new Date("2026-09-01T00:00:00Z"),
		coveredContextCount: 4,
	});
	const ranked = Array.from({ length: 3 }, (_, i) => ({
		id: `source-${i}`,
		type: "TEXT",
		score: 0.9 - i / 10,
		content: "Whole body",
		matchedPassages: [
			{
				content: `MATCH-${i} ${"relevant detail ".repeat(146)}`,
				score: 0.9 - i / 10,
			},
		],
	}));
	const injected = await applyContextSummary(ranked, {
		projectId: "example-project",
	});
	const result = render(injected);
	expect(result.context).toContain("SOURCE REFERENCES");
	expect(result.context).toContain("source-reference");
	expect(
		(result.context.match(/Background detail/g) ?? []).length *
			"Background detail".length,
	).toBeGreaterThan(800);
	for (const source of ranked) {
		expect(result.context).toContain(
			source.matchedPassages[0].content.trimEnd(),
		);
	}
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("explicitly marks a summary reference legend too large for its reserved share", () => {
	const result = render([
		{
			id: "summary-1",
			type: "PROJECT_SUMMARY",
			score: 1,
			metadata: { isSummary: true },
			content: `Summary [S1]\n${"Body\n".repeat(4000)}\n---\nSOURCE REFERENCES\n${"[S1] = source-reference\n".repeat(1000)}`,
		},
	]);
	expect(result.context).toContain("reference list was cut");
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("keeps a larger reference legend complete when it fits the result budget", () => {
	const legend = `SOURCE REFERENCES\n${Array.from({ length: 80 }, (_, i) => `[S${i}] = source-reference-${i}`).join("\n")}`;
	const result = render([
		{
			id: "summary-1",
			type: "PROJECT_SUMMARY",
			score: 1,
			metadata: { isSummary: true },
			content: `Summary [S1]\n${"Background\n".repeat(1200)}\n---\n${legend}`,
		},
	]);
	expect(result.context).toContain(legend);
	expect(result.context).not.toContain("reference list was cut");
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

// Allocation properties: unused room must reach fallback bodies after ranked text.
it("uses spare budget for a large summary after one short ranked source", () => {
	const summary = "S".repeat(14000);
	const result = render([
		{ id: "summary", type: "PROJECT_SUMMARY", score: 1, content: summary },
		{
			id: "short",
			type: "TEXT",
			score: 0.9,
			content: "Whole",
			matchedPassages: [{ content: "Ranked short passage", score: 0.9 }],
		},
	]);
	expect(result.context).toContain("Ranked short passage");
	expect((result.context.match(/S/g) ?? []).length).toBeGreaterThan(8500);
	expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(9995);
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
	expect(result.context).toMatch(/omitted|cut/i);
});

it("extends older points in result order when there are no matched chunks", () => {
	const result = render([
		{ id: "old-a", type: "TEXT", score: 0.9, content: "A".repeat(5000) },
		{ id: "old-b", type: "TEXT", score: 0.8, content: "B".repeat(12000) },
	]);
	expect(result.context).toContain("A".repeat(5000));
	expect(result.context).toContain("B".repeat(3500));
	expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(9995);
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("reserves every opening before extending ranked passages in score order", () => {
	const sources = Array.from({ length: 8 }, (_, i) => ({
		id: `ranked-${i}`,
		type: "TEXT",
		score: 0.9 - i / 100,
		content: "Whole",
		matchedPassages: [
			{ content: String(i).repeat(6000), score: 0.9 - i / 100 },
		],
	}));
	const result = render([
		{
			id: "summary",
			type: "PROJECT_SUMMARY",
			score: 1,
			content: "S".repeat(20000),
		},
		...sources,
	]);
	for (let i = 0; i < sources.length; i++) {
		expect(result.context).toContain(String(i).repeat(300));
	}
	expect((result.context.match(/0/g) ?? []).length).toBeGreaterThan(
		(result.context.match(/7/g) ?? []).length,
	);
	expect((result.context.match(/S/g) ?? []).length).toBeLessThan(801);
	expect(result.context).toMatch(/omitted|cut/i);
	expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(9995);
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it.each(["x", "\n", '"', "😀"])(
	"fills the serialized budget safely for %s",
	(unit) => {
		const result = render([
			{ id: "old", type: "TEXT", score: 1, content: unit.repeat(20000) },
		]);
		expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(9995);
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
	},
);

it("uses spare room for an oversized reference trailer when the body is short", () => {
	const result = render([
		{
			id: "summary",
			type: "PROJECT_SUMMARY",
			score: 1,
			content:
				"Short summary\n---\nSOURCE REFERENCES\n" +
				"[S1] = example-source\n".repeat(1000),
		},
	]);
	expect(result.context).toContain("reference list was cut");
	expect(result.context).toContain("SOURCE REFERENCES");
	expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(9995);
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("protects opening shares even when JSON escaping makes text expensive", () => {
	const sources = Array.from({ length: 8 }, (_, i) => ({
		id: `source-${i}`,
		type: "TEXT",
		score: 1 - i / 10,
		content: `\u0001${String.fromCharCode(65 + i)}`.repeat(3000),
	}));
	const result = render(sources);
	for (let i = 0; i < 8; i++) {
		expect(result.context).toContain(
			`\u0001${String.fromCharCode(65 + i)}`.repeat(50),
		);
	}
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("shows the entire 4850-character summary when the other source is short", () => {
	const body = "S".repeat(4850);
	const result = render([
		{ id: "summary", type: "PROJECT_SUMMARY", score: 1, content: body },
		{
			id: "short",
			type: "TEXT",
			score: 0.9,
			content: "Whole",
			matchedPassages: [{ content: "Short match", score: 0.9 }],
		},
	]);
	expect(result.context).toContain(body);
	expect(result.context).toContain("Short match");
	expect(result.context).not.toContain("Content omitted");
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("extends all matched passages by score even across source and passage positions", () => {
	const result = render([
		{
			id: "low",
			type: "TEXT",
			score: 0.5,
			content: "Whole",
			matchedPassages: [
				{ content: "L".repeat(12000), score: 0.5 },
				{ content: "H".repeat(3000), score: 0.95 },
			],
		},
		{
			id: "high",
			type: "TEXT",
			score: 0.9,
			content: "Whole",
			matchedPassages: [{ content: "M".repeat(12000), score: 0.9 }],
		},
	]);
	expect(result.context).toContain("H".repeat(3000));
	expect(result.context).toContain("M".repeat(4000));
	expect(result.context).toContain("L".repeat(800));
	expect(result.context).not.toContain("L".repeat(801));
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("pins the previous Advisor default output exactly", async () => {
	const { default: baseline } = await import(
		"./project-context-passages.baseline.json"
	);
	expect(
		render([
			{
				id: "example-source",
				type: "TEXT",
				score: 0.9,
				content: "Whole document",
				matchedPassages: [
					{ content: "Matched detail\n".repeat(1500), score: 0.9 },
				],
			},
		]),
	).toEqual(baseline);
});
it("extends the budget and names the editor source tool", () => {
	const input = [
		{
			id: "example-source",
			type: "TEXT",
			score: 1,
			content: "x".repeat(50000),
		},
	];
	const result = compactProjectContextPassages(
		input,
		"Search results",
		() => "",
		{
			maxChars: 24000,
			fullSourceNote: (id) => `read_project_source({"sourceId":"${id}"})`,
		},
	);
	expect(result.context.length).toBeGreaterThan(render(input).context.length);
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(24000);
	expect(result.context).toContain(
		'read_project_source({"sourceId":"example-source"})',
	);
});
