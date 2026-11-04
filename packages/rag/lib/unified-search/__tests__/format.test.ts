import { describe, expect, it } from "vitest";
import { formatUnifiedResultsForPrompt } from "../format";
import type {
	ProjectSearchResponse,
	UnifiedSearchResult,
	UnifiedSearchSourceType,
} from "../types";

const result = (
	id: string,
	type: UnifiedSearchSourceType,
	content: string,
): UnifiedSearchResult => ({
	id,
	content,
	relevance: 0.9,
	source: { type, name: id, badge: type },
});
const response = (results: UnifiedSearchResult[]): ProjectSearchResponse => ({
	results,
	sourceCounts: {
		"project-context": 3,
		workspace: 1,
		connector: 1,
		artifact: 1,
		web: 1,
		code: 1,
	},
	sourcesSearched: [
		"project-context",
		"workspace",
		"connector",
		"artifact",
		"web",
		"code",
	],
	searchTimeMs: 12,
});

describe("one unified prompt budget", () => {
	it("bounds mixed large sources and keeps every selected header in rank order", () => {
		const results = [0, 1, 2].map((i) =>
			result(`project-${i}`, "project-context", `${i}`.repeat(100000)),
		);
		results.push(
			...(
				["workspace", "connector", "artifact", "web", "code"] as const
			).map((type) => result(`${type}-snippet`, type, `${type} detail`)),
		);
		const output = formatUnifiedResultsForPrompt(response(results));
		expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
		let previous = -1;
		for (const r of results) {
			const position = output.indexOf(
				`--- [${r.source.badge}] ${r.source.name} (relevance: 90.0%) ---`,
			);
			expect(position).toBeGreaterThan(previous);
			previous = position;
		}
		expect(output).toContain("<unified_search_results>");
		expect(output).toContain("Sources searched:");
		expect(output).toContain("</unified_search_results>");
	});
	it("uses matched passages and labels their extent without assuming a full-source tool is available", () => {
		const r = result(
			"matched",
			"project-context",
			"WHOLE BODY MUST NOT APPEAR",
		);
		r.matchedPassages = [{ content: "Relevant passage", score: 0.9 }];
		const output = formatUnifiedResultsForPrompt(response([r]));
		expect(output).toContain("Relevant passage");
		expect(output).not.toContain("WHOLE BODY");
		expect(output).toContain("Matched passages only.");
		expect(output).not.toContain("fabric_get_project_source");
		expect(output).not.toContain("Content omitted");
	});
	it("uses the start of an older body and labels only cut results", () => {
		const old = result(
			"older",
			"project-context",
			`BODY START ${"x".repeat(100000)} BODY END`,
		);
		old.matchedPassages = [];
		const output = formatUnifiedResultsForPrompt(
			response([old, result("short", "web", "Full short snippet")]),
		);
		const [cut, whole] = output.split("--- [web]");
		expect(cut).toContain("BODY START");
		expect(cut).toContain("Showing the start of the document.");
		expect(cut).not.toContain("BODY END");
		expect(cut).toContain("Content omitted");
		expect(whole).toContain("Full short snippet");
		expect(whole).not.toContain("Content omitted");
	});
	it.each(["x", "\n", '"', "😀"])(
		"applies the budget once across individually small results (%s)",
		(unit) => {
			const output = formatUnifiedResultsForPrompt(
				response(
					Array.from({ length: 8 }, (_, i) =>
						result(`source-${i}`, "web", unit.repeat(3000)),
					),
				),
			);
			expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
			expect(output).toContain("Content omitted");
			for (let i = 0; i < 8; i++) {
				expect(output).toContain(`source-${i}`);
			}
			expect(output).not.toMatch(
				/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
			);
		},
	);
	it("names sources omitted when metadata alone exceeds the budget", () => {
		const output = formatUnifiedResultsForPrompt(
			response([result("huge".repeat(4000), "web", "text")]),
		);
		expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
		expect(output).toMatch(/metadata|source blocks omitted/);
	});
});

it("reserves source instructions even for a cut matched passage", () => {
	const r = result("guided", "project-context", "Whole body");
	r.contentHeader = "Source type: Policy\nUse as guidance.\n";
	r.matchedPassages = [
		{ content: "Matched text ".repeat(10000), score: 0.9 },
	];
	const output = formatUnifiedResultsForPrompt(response([r]));
	expect(output).toContain(r.contentHeader);
	expect(output).toContain("Matched text");
	expect(output).toContain("Content omitted");
	expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
});
it("reserves a summary reference legend before extending its body", () => {
	const r = result(
		"summary",
		"project-context",
		`Summary [S1]\n${"Background\n".repeat(10000)}\n---\nSOURCE REFERENCES\n[S1] = example-source`,
	);
	r.metadata = { isSummary: true };
	const output = formatUnifiedResultsForPrompt(response([r]));
	expect(output).toContain("Showing the start of the summary.");
	expect(output).toContain("SOURCE REFERENCES\n[S1] = example-source");
	expect(output).toContain("Content omitted");
	expect(output).not.toContain("reference list was cut");
	expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
});
it("marks a summary reference legend that cannot fit", () => {
	const r = result(
		"summary",
		"project-context",
		`Summary [S1]\n---\nSOURCE REFERENCES\n${"[S1] = example-source\n".repeat(1000)}`,
	);
	r.metadata = { isSummary: true };
	const output = formatUnifiedResultsForPrompt(response([r]));
	expect(output).toContain("reference list was cut");
	expect(output).toContain("SOURCE REFERENCES");
	expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
});
it("returns no prompt block for an empty search", () => {
	expect(formatUnifiedResultsForPrompt(response([]))).toBe("");
});
it("keeps short matched passages complete with no cut label", () => {
	const r = result("matched", "project-context", "Whole body");
	r.matchedPassages = [
		{ content: "First match", score: 0.4 },
		{ content: "Best match", score: 0.9 },
	];
	const output = formatUnifiedResultsForPrompt(response([r]));
	expect(output).toContain("First match\n\nBest match");
	expect(output).not.toContain("Content omitted");
});

it("keeps fitting headers and names a later source whose metadata is oversized", () => {
	const output = formatUnifiedResultsForPrompt(
		response([
			result("small", "web", "Short snippet"),
			result("huge".repeat(4000), "web", "text"),
		]),
	);
	expect(output).toContain("--- [web] small");
	expect(output).toContain("Short snippet");
	expect(output).toContain("1 source blocks omitted");
	expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
});

it("extends final result rank before a lower result's higher raw passage score", () => {
	const workspace = result("rank-first", "workspace", "W".repeat(50000));
	workspace.relevance = 0.36;
	const project = result("rank-second", "project-context", "Whole body");
	project.relevance = 0.3;
	project.matchedPassages = [{ content: "P".repeat(50000), score: 0.5 }];
	const output = formatUnifiedResultsForPrompt(
		response([workspace, project]),
	);
	expect((output.match(/W/g) ?? []).length).toBeGreaterThan(8000);
	expect((output.match(/P/g) ?? []).length).toBe(800);
	expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
});
it("uses passage scores within a result before extending the next result", () => {
	const first = result("rank-first", "project-context", "Whole body");
	first.relevance = 0.36;
	first.matchedPassages = [
		{ content: "L".repeat(50000), score: 0.1 },
		{ content: "H".repeat(50000), score: 0.2 },
	];
	const second = result("rank-second", "project-context", "Whole body");
	second.relevance = 0.3;
	second.matchedPassages = [{ content: "B".repeat(50000), score: 0.99 }];
	const output = formatUnifiedResultsForPrompt(response([first, second]));
	expect((output.match(/H/g) ?? []).length).toBeGreaterThan(7000);
	expect((output.match(/L/g) ?? []).length).toBe(800);
	expect((output.match(/B/g) ?? []).length).toBe(800);
	expect(JSON.stringify(output).length).toBeLessThanOrEqual(10000);
});
