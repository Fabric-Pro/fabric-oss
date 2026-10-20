import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_ACCESS_SKILL,
	INSTRUCTION_CATALOG,
	type InstructionSourceIdentity,
	instructionAccessBootstrap,
	instructionAccessSkill,
	instructionCatalog,
} from "../src/lib/plugin/instruction-access.js";
import {
	buildPlugin,
	type InstructionFile,
	LIVING_MEMORY_SKILL,
	pluginNameFor,
	SESSION_CONTEXT_LIMIT,
} from "../src/lib/plugin/layout.js";
import { capRules } from "../src/lib/plugin/rules.js";

const encode = (text: string) => new TextEncoder().encode(text);
const source: InstructionSourceIdentity = {
	kind: "repository",
	generation: 7,
	commitSha: "a".repeat(40),
};
const file = (path: string, text: string): InstructionFile => ({
	path,
	bytes: encode(text),
});

function build(
	files: InstructionFile[],
	paths = files.map((entry) => entry.path),
	projectId = "example-project",
) {
	return buildPlugin({
		tool: "claude-code",
		projectId,
		files,
		memory: { state: "known", ref: "main", folders: [] },
		gatewayUrl: `https://example.com/api/mcp-gateway/projects/${projectId}`,
		pin: "render-hash",
		instructionAccess: {
			source,
			listed: paths.map((path) => ({ path, kind: "OTHER" })),
		},
	});
}

function textOf(files: ReturnType<typeof build>, path: string): string {
	const entry = files.find((entry) => entry.path === path);
	if (entry === undefined) throw new Error(`Missing ${path}`);
	return new TextDecoder().decode(entry.bytes);
}

describe("instruction access", () => {
	it("names the owning plugin when two projects have the same short root instructions", () => {
		const projects = ["example-project-one", "example-project-two"];
		for (const projectId of projects) {
			const tree = build(
				[file("CLAUDE.md", "@MAIN.md\n")],
				undefined,
				projectId,
			);
			const hook = JSON.parse(textOf(tree, "hooks/session-context.json"));
			const context = hook.hookSpecificOutput.additionalContext;
			const name = pluginNameFor(projectId);
			expect(context).toContain(`plugin ${name}`);
			expect(context).toContain(`/${name}:${INSTRUCTION_ACCESS_SKILL}`);
			expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
			for (const other of projects.filter((id) => id !== projectId)) {
				expect(context).not.toContain(pluginNameFor(other));
			}
		}
	});

	it("names the owning Codex plugin without adding Claude invocation syntax", () => {
		const first = instructionAccessBootstrap("fabric-one", "codex");
		const second = instructionAccessBootstrap("fabric-two", "codex");
		expect(first).toContain("plugin fabric-one");
		expect(first).not.toContain("fabric-two");
		expect(second).toContain("plugin fabric-two");
		expect(second).not.toContain("fabric-one");
		expect(first).not.toContain("/fabric-one:");
		expect(second).not.toContain("/fabric-two:");
	});

	it("catalogs all 1648 original paths, including root references and 34 rules beyond automatic delivery", () => {
		const rules = Array.from({ length: 56 }, (_, index) => ({
			path: `rule-${String(index).padStart(2, "0")}.md`,
			source: `rules/rule-${String(index).padStart(2, "0")}.md`,
			bytes: encode("r".repeat(11_500)),
		}));
		expect(capRules(rules)).toMatchObject({ omitted: 34 });
		expect(capRules(rules).kept).toHaveLength(22);
		const paths = [
			"CLAUDE.md",
			"MAIN.md",
			"scripts/check.sh",
			"engineers/guide.md",
			...rules.map((rule) => rule.source),
			...Array.from(
				{ length: 1588 },
				(_, index) => `knowledge/topic-${index}.md`,
			),
		];
		const files = [
			file("CLAUDE.md", "@MAIN.md\n"),
			...rules.map((rule) => ({ path: rule.source, bytes: rule.bytes })),
		];
		const tree = build(files, paths);
		const catalog = JSON.parse(textOf(tree, INSTRUCTION_CATALOG));
		expect(catalog.entries).toHaveLength(1648);
		expect(catalog.source).toEqual(source);
		expect(catalog.entries).toEqual(
			expect.arrayContaining([
				{
					path: "CLAUDE.md",
					kind: "OTHER",
					localPath: "instructions/CLAUDE.md",
				},
				{ path: "MAIN.md", kind: "OTHER", localPath: null },
				{
					path: rules[55]?.source,
					kind: "OTHER",
					localPath: `instructions/source/${rules[55]?.source}`,
				},
			]),
		);
		expect(textOf(tree, `instructions/source/${rules[55]?.source}`)).toBe(
			"r".repeat(11_500),
		);
		expect(textOf(tree, INSTRUCTION_CATALOG)).not.toContain("rrrrrrrr");
		expect(textOf(tree, "instructions/CLAUDE.md")).toBe("@MAIN.md\n");
		expect(textOf(tree, "hooks/session-context.json")).toContain(
			INSTRUCTION_ACCESS_SKILL,
		);
		expect(tree.some((entry) => entry.path === "MAIN.md")).toBe(false);
	});

	it("keeps discovery before a truncated root and within the complete hook context budget", () => {
		const root = `@MAIN.md\n${"line of instructions\n".repeat(2000)}`;
		const tree = build([file("CLAUDE.md", root)], ["CLAUDE.md", "MAIN.md"]);
		const context = JSON.parse(textOf(tree, "hooks/session-context.json"))
			.hookSpecificOutput.additionalContext;
		expect(
			context.startsWith(
				instructionAccessBootstrap(
					pluginNameFor("example-project"),
					"claude-code",
				),
			),
		).toBe(true);
		expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
		expect(context.indexOf(INSTRUCTION_ACCESS_SKILL)).toBeLessThan(
			context.indexOf("@MAIN.md"),
		);
		expect(textOf(tree, "instructions/CLAUDE.md")).toBe(root);
	});

	it("preserves native components and reserves both generated skill folders without false local mappings", () => {
		const files = [
			file(
				`skills/${INSTRUCTION_ACCESS_SKILL}/SKILL.md`,
				"source access skill",
			),
			file(
				`skills/${INSTRUCTION_ACCESS_SKILL}/catalog.json`,
				"source catalog",
			),
			file(`skills/${INSTRUCTION_ACCESS_SKILL}/extra.md`, "extra"),
			file(
				`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
				"source memory skill",
			),
			file(`skills/${LIVING_MEMORY_SKILL}/extra.md`, "extra"),
			file("skills/sprint/SKILL.md", "native skill"),
			file("skills/sprint/scripts/run.sh", "native supporting script"),
			file("agents/review.md", "native agent"),
		];
		const tree = build(files);
		const catalog = JSON.parse(textOf(tree, INSTRUCTION_CATALOG));
		for (const entry of catalog.entries) {
			if (
				entry.path.startsWith(`skills/${INSTRUCTION_ACCESS_SKILL}/`) ||
				entry.path.startsWith(`skills/${LIVING_MEMORY_SKILL}/`)
			) {
				expect(entry.localPath).toBeNull();
			}
		}
		expect(
			textOf(tree, `skills/${INSTRUCTION_ACCESS_SKILL}/SKILL.md`),
		).toBe(instructionAccessSkill());
		expect(
			textOf(tree, `skills/${LIVING_MEMORY_SKILL}/SKILL.md`),
		).toContain("no memory folders yet");
		for (const original of files.slice(5)) {
			expect(textOf(tree, original.path)).toBe(
				new TextDecoder().decode(original.bytes),
			);
		}
		expect(tree.some((entry) => entry.path.endsWith("/extra.md"))).toBe(
			false,
		);
	});

	it("produces sorted deterministic JSON metadata and rejects unsafe paths", () => {
		const listed = [
			{ path: "z.md", size: 13 },
			{ path: "a.md", size: 2 },
		];
		const input = {
			projectId: "example-project",
			source,
			listed,
			localPaths: new Map<string, string>(),
		};
		expect(instructionCatalog(input)).toBe(
			instructionCatalog({ ...input, listed: [...listed].reverse() }),
		);
		expect(() =>
			instructionCatalog({
				...input,
				listed: [{ path: "../outside.md" }],
			}),
		).toThrow(/unsafe/);
		expect(() =>
			instructionCatalog({
				...input,
				listed: [{ path: "A.md" }, { path: "a.md" }],
			}),
		).toThrow(/colliding/);
	});

	it("names exact MCP paging, pin checks, original paths and explicit read refusals", () => {
		const skill = instructionAccessSkill();
		for (const term of [
			"fabric_list_project_instructions",
			"fabric_get_project_instruction",
			"page.nextCursor",
			"direct.generation",
			"direct.commitSha",
			"offset: nextOffset",
			"nextOffset is null",
			"snapshot.digest",
			"snapshot.version",
			"snapshotVersion on every file page",
			"sinceDigest",
			"@MAIN.md",
			"tooLarge",
			"Never substitute",
			"Do not load the whole catalog",
			"read every unscoped rule",
			"paths: frontmatter of each original rule",
			"report the blocked work",
		]) {
			expect(skill).toContain(term);
		}
		expect(skill).not.toContain("fabric_memory_write");
	});
});
