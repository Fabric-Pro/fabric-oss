import {
	buildCodeSnippetPrompt,
	buildComprehensiveFileContext,
	extractCodeReferences,
	extractExportedSymbols,
	extractImportExportContext,
	extractImportedModules,
	extractLineWindow,
	formatCodeReference,
	hasCodeReferences,
	identifyRelatedFiles,
	summarizeModuleContext,
} from "../code-references";

describe("code-references", () => {
	const sampleFile = [
		"import { useMemo } from 'react';",
		"import { cn } from '@ui/lib';",
		"import { helper } from './helper';",
		"import { formatValue } from './formatter';",
		"",
		"export interface ExampleProps { value: string }",
		"export function Example({ value }: ExampleProps) {",
		"\tconst label = cn('rounded', value);",
		"\tconst memo = useMemo(() => helper(value).toUpperCase(), [value]);",
		"",
		"\treturn <div>{memo}</div>;",
		"}",
		"",
		"export const EXAMPLE_VERSION = '1.0.0';",
		"export default Example;",
	].join("\n");

	const helperFile = [
		"export function helper(value: string) {",
		"\treturn value + '-helper';",
		"}",
	].join("\n");

	it("detects and formats file line references", () => {
		const refs = extractCodeReferences(
			"Please inspect apps/web/modules/example.tsx:4-6 and src/lib/foo.ts:8",
		);

		expect(refs).toHaveLength(2);
		expect(hasCodeReferences("Look at src/lib/foo.ts:8")).toBe(true);
		expect(formatCodeReference(refs[0])).toBe(
			"apps/web/modules/example.tsx:4-6",
		);
	});

	it("extracts a surrounding line window", () => {
		const window = extractLineWindow(sampleFile, 7, 8, 1);

		expect(window.lineStart).toBe(6);
		expect(window.lineEnd).toBe(9);
		expect(window.content).toContain("export function Example");
		expect(window.content).toContain("const memo = useMemo");
	});

	it("extracts import and export header context from the top of a file", () => {
		const header = extractImportExportContext(sampleFile);

		expect(header).toContain("import { useMemo } from 'react';");
		expect(header).toContain("import { cn } from '@ui/lib';");
		expect(header).toContain("import { helper } from './helper';");
		expect(header).not.toContain("return <div>{memo}</div>;");
	});

	it("extracts imported modules, exports, and likely related files for module context", () => {
		expect(extractImportedModules(sampleFile)).toEqual([
			"react",
			"@ui/lib",
			"./helper",
			"./formatter",
		]);
		expect(extractExportedSymbols(sampleFile)).toEqual(
			expect.arrayContaining([
				"ExampleProps",
				"Example",
				"EXAMPLE_VERSION",
				"default",
			]),
		);
		const ranked = identifyRelatedFiles(
			"apps/web/modules/example.tsx",
			sampleFile,
			8,
			9,
		);
		expect(ranked).toEqual(
			expect.arrayContaining([
				"apps/web/modules/helper",
				"apps/web/modules/helper.ts",
				"apps/web/modules/formatter",
			]),
		);
		expect(ranked.indexOf("apps/web/modules/helper")).toBeLessThan(
			ranked.indexOf("apps/web/modules/formatter"),
		);
	});

	it("summarizes module context for richer code q-and-a", () => {
		const summary = summarizeModuleContext(
			"apps/web/modules/example.tsx",
			sampleFile,
		);

		expect(summary.exportedSymbols).toEqual(
			expect.arrayContaining([
				"ExampleProps",
				"Example",
				"EXAMPLE_VERSION",
				"default",
			]),
		);
		expect(summary.localImports).toEqual(["./helper", "./formatter"]);
		expect(summary.externalDependencies).toEqual(["react", "@ui/lib"]);
		expect(summary.likelyRelatedFiles).toEqual(
			expect.arrayContaining([
				"apps/web/modules/helper.ts",
				"apps/web/modules/formatter.ts",
			]),
		);
		expect(
			summary.likelyRelatedFiles.indexOf("apps/web/modules/helper"),
		).toBeLessThan(
			summary.likelyRelatedFiles.indexOf("apps/web/modules/formatter"),
		);
	});

	it("builds a richer code snippet prompt with module context, numbered selected and surrounding context", () => {
		const prompt = buildCodeSnippetPrompt(
			"apps/web/modules/example.tsx",
			sampleFile,
			7,
			8,
			{ surroundingLines: 1, includeImports: true },
		);

		expect(prompt).toContain("File: apps/web/modules/example.tsx:7-8");
		expect(prompt).toContain("Module context:");
		expect(prompt).toContain("Exports:");
		expect(prompt).toContain("ExampleProps");
		expect(prompt).toContain("Example");
		expect(prompt).toContain("EXAMPLE_VERSION");
		expect(prompt).toContain("default");
		expect(prompt).toContain("Local imports: ./helper");
		expect(prompt).toContain("External dependencies: react, @ui/lib");
		expect(prompt).toContain("Likely related files:");
		expect(prompt).toContain("Header context:");
		expect(prompt).toContain("Surrounding context (6-9):");
		expect(prompt).toContain("Selected lines (7-8):");
		expect(prompt).toContain("7 | \tconst label = cn('rounded', value);");
		expect(prompt).toContain(
			"8 | \tconst memo = useMemo(() => helper(value).toUpperCase(), [value]);",
		);
	});

	it("builds comprehensive file context with compact related file summaries", () => {
		const context = buildComprehensiveFileContext(
			"apps/web/modules/example.tsx",
			sampleFile,
			7,
			8,
			[
				{
					path: "apps/web/modules/helper.ts",
					content: helperFile,
				},
			],
			{ maxRelatedFiles: 2 },
		);

		expect(context).toContain("Related files:");
		expect(context).toContain("apps/web/modules/helper.ts");
		expect(context).toContain("Module context:");
		expect(context).toContain("Exports: helper");
		expect(context).toContain("Header:");
		expect(context).toContain("export function helper(value: string)");
	});
});
