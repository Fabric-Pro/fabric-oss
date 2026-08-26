import { beforeAll, describe, expect, it } from "vitest";
import { buildTechnicalGraph, type FileRecord } from "../graph/build";

const files: FileRecord[] = [
	{
		path: "src/a/foo.ts",
		content: `import { bar } from "../b/bar";\nexport function foo() { return bar(); }`,
	},
	{ path: "src/b/bar.ts", content: "export function bar() { return 1; }" },
	{ path: "src/b/baz.ts", content: "export const baz = 2;" },
];

describe("buildTechnicalGraph", () => {
	let graph: Awaited<ReturnType<typeof buildTechnicalGraph>>;
	beforeAll(async () => {
		graph = await buildTechnicalGraph(files);
	});

	it("creates a FILE node per source file", () => {
		const fileNodes = graph.nodes.filter((n) => n.kind === "FILE");
		expect(fileNodes.map((n) => n.key).sort()).toEqual([
			"src/a/foo.ts",
			"src/b/bar.ts",
			"src/b/baz.ts",
		]);
	});

	it("creates MODULE nodes and attaches files via parentKey + CONTAINS", () => {
		const moduleKeys = graph.nodes
			.filter((n) => n.kind === "MODULE")
			.map((n) => n.key)
			.sort();
		expect(moduleKeys).toEqual(["src/a", "src/b"]);

		const foo = graph.nodes.find((n) => n.key === "src/a/foo.ts");
		expect(foo?.parentKey).toBe("src/a");

		const contains = graph.edges.filter((e) => e.kind === "CONTAINS");
		expect(contains).toContainEqual(
			expect.objectContaining({
				source: "src/a",
				target: "src/a/foo.ts",
				kind: "CONTAINS",
			}),
		);
	});

	it("creates an IMPORTS edge for a resolved relative import", () => {
		const imports = graph.edges.filter((e) => e.kind === "IMPORTS");
		expect(imports).toContainEqual(
			expect.objectContaining({
				source: "src/a/foo.ts",
				target: "src/b/bar.ts",
				kind: "IMPORTS",
			}),
		);
	});

	it("aggregates file imports into a module DEPENDS_ON edge", () => {
		const deps = graph.edges.filter((e) => e.kind === "DEPENDS_ON");
		expect(deps).toContainEqual(
			expect.objectContaining({
				source: "src/a",
				target: "src/b",
				kind: "DEPENDS_ON",
				weight: 1,
			}),
		);
	});

	it("records metrics, content preview and a structural description on files", () => {
		const bar = graph.nodes.find((n) => n.key === "src/b/bar.ts");
		expect(bar?.metrics?.loc).toBeGreaterThan(0);
		expect(bar?.metrics?.dependentCount).toBe(1); // imported by foo.ts
		expect(bar?.contentPreview).toContain("bar");
		expect(bar?.structuralDescription).toMatch(/TypeScript file/);
		expect(bar?.contentHash).toBeTruthy();
	});

	it("ignores files with no detectable language", async () => {
		const g = await buildTechnicalGraph([
			{ path: "README.md", content: "# hi" },
			{ path: "src/x.ts", content: "export const x = 1;" },
		]);
		expect(
			g.nodes.filter((n) => n.kind === "FILE").map((n) => n.key),
		).toEqual(["src/x.ts"]);
	});
});
