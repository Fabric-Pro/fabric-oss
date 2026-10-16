import { describe, expect, it } from "vitest";
import {
	alwaysOnFile,
	buildPlugin,
	type InstructionFile,
	isFabricAgentsOverride,
	LIVING_MEMORY_SKILL,
	type MemoryFolders,
	mergedAgentsOverride,
	pluginNameFor,
	pluginPathFor,
	SESSION_CONTEXT_LIMIT,
	sessionContext,
} from "../src/lib/plugin/layout.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const PROJECT = "cmexampleproject0123456789";
const GATEWAY =
	"https://example.com/api/mcp-gateway/projects/cmexampleproject0123456789";

function file(path: string, text: string, mode?: number): InstructionFile {
	return { path, bytes: encode(text), mode };
}

const FOLDERS: MemoryFolders = {
	state: "known",
	ref: "main",
	folders: [
		{ folder: "docs/ai", mode: "PULL_REQUEST" },
		{ folder: "docs/notes", mode: "DIRECT_PUSH" },
	],
};

function build(
	files: InstructionFile[],
	options: { tool?: "claude-code" | "codex"; memory?: MemoryFolders } = {},
) {
	return buildPlugin({
		tool: options.tool ?? "claude-code",
		projectId: PROJECT,
		files,
		memory: options.memory ?? FOLDERS,
		gatewayUrl: GATEWAY,
		pin: "abc123def456",
	});
}

function textOf(files: ReturnType<typeof build>, path: string): string {
	const found = files.find((entry) => entry.path === path);
	if (found === undefined) {
		throw new Error(`missing ${path}`);
	}
	return decode(found.bytes);
}

describe("pluginNameFor", () => {
	it("is stable and built from the end of the project id", () => {
		expect(pluginNameFor(PROJECT)).toBe("fabric-23456789");
		expect(pluginNameFor(PROJECT)).toBe(pluginNameFor(PROJECT));
	});

	it("is a valid plugin name for any id", () => {
		expect(pluginNameFor("A_b-C.d")).toMatch(/^fabric-[a-z0-9]+$/);
		expect(pluginNameFor("---")).toBe("fabric-project");
	});
});

describe("pluginPathFor", () => {
	it.each([
		[".claude/skills/deploy/SKILL.md", "skills/deploy/SKILL.md"],
		[
			".claude/skills/deploy/scripts/run.sh",
			"skills/deploy/scripts/run.sh",
		],
		[".claude/agents/reviewer.md", "agents/reviewer.md"],
		[".claude/commands/ship.md", "commands/ship.md"],
		[".claude/commands/team/ship.md", "commands/team/ship.md"],
		["Skills/deploy/SKILL.md", "skills/deploy/SKILL.md"],
		["Agents/reviewer.md", "agents/reviewer.md"],
	])("maps %s to %s", (from, to) => {
		expect(pluginPathFor(from)).toBe(to);
	});

	it.each([
		"CLAUDE.md",
		".claude/settings.json",
		".claude/rules/style.md",
		".claude/skills/loose.md",
		".claude/agents/tools/helper.py",
		"docs/guide.md",
		"README.md",
	])("leaves %s out", (path) => {
		expect(pluginPathFor(path)).toBeNull();
	});
});

describe("the Claude Code plugin", () => {
	const files = [
		file("CLAUDE.md", "# Rules\nBe kind.\n"),
		file(
			".claude/skills/deploy/SKILL.md",
			"---\nname: deploy\n---\nDeploy.\n",
		),
		file(".claude/skills/deploy/run.sh", "#!/bin/sh\necho\n", 0o755),
		file(".claude/agents/reviewer.md", "reviewer"),
		file(".claude/commands/ship.md", "ship"),
		file(".claude/rules/ignored.md", "ignored"),
	];

	it("maps the layout and nothing else", () => {
		const paths = build(files).map((entry) => entry.path);

		expect(paths).toEqual([
			".claude-plugin/plugin.json",
			".mcp.json",
			"agents/reviewer.md",
			"commands/ship.md",
			"hooks/hooks.json",
			"hooks/session-context.json",
			"instructions/CLAUDE.md",
			"skills/deploy/SKILL.md",
			"skills/deploy/run.sh",
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		]);
	});

	it("keeps a script executable and the rest readable", () => {
		const tree = build(files);

		expect(
			tree.find((entry) => entry.path === "skills/deploy/run.sh")?.mode,
		).toBe(0o755);
		expect(
			tree.find((entry) => entry.path === "agents/reviewer.md")?.mode,
		).toBe(0o644);
	});

	it("names the plugin and points its MCP server at the project gateway", () => {
		const tree = build(files);

		expect(
			JSON.parse(textOf(tree, ".claude-plugin/plugin.json")),
		).toMatchObject({
			name: "fabric-23456789",
		});
		expect(JSON.parse(textOf(tree, ".mcp.json"))).toEqual({
			mcpServers: {
				"fabric-23456789": { type: "http", url: GATEWAY },
			},
		});
	});

	it("hands CLAUDE.md to the session as SessionStart context", () => {
		const tree = build(files);

		const output = JSON.parse(textOf(tree, "hooks/session-context.json"));
		expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(output.hookSpecificOutput.additionalContext).toContain(
			"Be kind.",
		);
		const hooks = JSON.parse(textOf(tree, "hooks/hooks.json"));
		expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
			"$" + "{CLAUDE_PLUGIN_ROOT}/hooks/session-context.json",
		);
		expect(textOf(tree, "instructions/CLAUDE.md")).toBe(
			"# Rules\nBe kind.\n",
		);
	});

	it("falls back to AGENTS.md when there is no CLAUDE.md", () => {
		const tree = build([file("AGENTS.md", "agents text\n")]);

		expect(textOf(tree, "hooks/session-context.json")).toContain(
			"agents text",
		);
		expect(textOf(tree, "instructions/AGENTS.md")).toBe("agents text\n");
	});

	it("writes no hook when there is no memory file", () => {
		const paths = build([file(".claude/agents/a.md", "a")]).map(
			(entry) => entry.path,
		);

		expect(paths).not.toContain("hooks/hooks.json");
		expect(paths).not.toContain("hooks/session-context.json");
	});

	it("is the same bytes however the input is ordered, every time", () => {
		const forward = build(files);
		const backward = build([...files].reverse());

		expect(backward).toEqual(forward);
		expect(build(files)).toEqual(forward);
	});

	it("lets the generated memory skill win a name clash", () => {
		const tree = build([
			file(`.claude/skills/${LIVING_MEMORY_SKILL}/SKILL.md`, "attacker"),
			file(`.claude/skills/${LIVING_MEMORY_SKILL}/extra.md`, "extra"),
		]);

		expect(
			textOf(tree, `skills/${LIVING_MEMORY_SKILL}/SKILL.md`),
		).toContain("Fabric Living Memory");
		expect(
			tree.some(
				(entry) =>
					entry.path === `skills/${LIVING_MEMORY_SKILL}/extra.md`,
			),
		).toBe(false);
	});
});

describe("the always-on text", () => {
	it("prefers CLAUDE.md for Claude Code and AGENTS.md for Codex", () => {
		const both = [file("CLAUDE.md", "claude"), file("AGENTS.md", "agents")];

		expect(alwaysOnFile(both)?.file).toBe("CLAUDE.md");
		expect(alwaysOnFile(both, "codex")?.file).toBe("AGENTS.md");
		expect(alwaysOnFile([file("CLAUDE.md", "claude")], "codex")?.file).toBe(
			"CLAUDE.md",
		);
	});

	it("ignores a file that is only whitespace", () => {
		expect(alwaysOnFile([file("CLAUDE.md", "  \n")])).toBeNull();
	});

	it("is passed whole when it fits", () => {
		const text = "x".repeat(9_000);

		const context = sessionContext("CLAUDE.md", text, "fabric-23456789");

		expect(context).toContain(text);
		expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
	});

	it("is cut at a line break, under the limit, with a notice saying where the rest is", () => {
		const lines = Array.from(
			{ length: 2_000 },
			(_, i) => `line ${i} of the rules`,
		);
		const text = lines.join("\n");

		const context = sessionContext("CLAUDE.md", text, "fabric-23456789");

		expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
		expect(context).toContain("line 0 of the rules");
		expect(context).not.toContain("line 1999 of the rules");
		expect(context).toContain("instructions/CLAUDE.md");
		expect(context).toContain("fabric-23456789");
		// The cut is at a line, not in the middle of one.
		const before = context.slice(0, context.indexOf("\n\n[Fabric:"));
		expect(lines).toContain(before.split("\n").at(-1));
	});

	it("never cuts a character in half", () => {
		const text = "😀".repeat(10_000);

		const context = sessionContext("AGENTS.md", text, "fabric-23456789");

		expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
		expect(context).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
	});

	it("keeps the whole file in the plugin when the hook cuts it", () => {
		const text = "y".repeat(30_000);

		const tree = build([file("CLAUDE.md", text)]);

		expect(textOf(tree, "instructions/CLAUDE.md")).toBe(text);
		const sent = JSON.parse(textOf(tree, "hooks/session-context.json"))
			.hookSpecificOutput.additionalContext as string;
		expect(sent.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
	});
});

describe("the Living Memory skill", () => {
	it("lists the write folders and how each lands", () => {
		const skill = textOf(
			build([]),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).toContain("name: fabric-living-memory");
		expect(skill).toContain("`docs/ai/`");
		expect(skill).toContain("pull request");
		expect(skill).toContain("`docs/notes/`");
		expect(skill).toContain("straight to the project's synced branch");
		expect(skill).toContain("Never save memory files anywhere else");
		expect(skill).toContain("a hook sends new and changed files");
	});

	it("tells Codex that the next session delivers the files, and names the tool", () => {
		const skill = textOf(
			build([], { tool: "codex" }),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).toContain("next session starts");
		expect(skill).toContain("fabric_memory_write");
	});

	it("says there is nowhere to write when the project has no folders", () => {
		const skill = textOf(
			build([], { memory: { state: "known", ref: "main", folders: [] } }),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).toContain("no memory folders yet");
		expect(skill).not.toContain("Never save memory files anywhere else");
	});

	it("says so when the folders could not be read", () => {
		const skill = textOf(
			build([], { memory: { state: "unavailable" } }),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).toContain("fabric memory status");
	});

	it("is short", () => {
		const skill = textOf(
			build([]),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill.length).toBeLessThan(1_500);
	});
});

describe("the Codex plugin", () => {
	it("is a manifest, an MCP file and skills, with no hooks and no CLAUDE.md slot", () => {
		const tree = build(
			[
				file("AGENTS.md", "agents"),
				file(".claude/skills/deploy/SKILL.md", "deploy"),
				file(".claude/agents/reviewer.md", "reviewer"),
			],
			{ tool: "codex" },
		);

		expect(tree.map((entry) => entry.path)).toEqual([
			"agents/reviewer.md",
			"mcp.json",
			"plugin.json",
			"skills/deploy/SKILL.md",
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		]);
		expect(JSON.parse(textOf(tree, "plugin.json"))).toMatchObject({
			name: "fabric-23456789",
			version: "0.0.0-abc123def456",
		});
		expect(JSON.parse(textOf(tree, "mcp.json"))).toEqual({
			mcpServers: {
				"fabric-23456789": { type: "streamable-http", url: GATEWAY },
			},
		});
	});
});

describe("mergedAgentsOverride", () => {
	it("puts the tracked file first and the instructions after it", () => {
		const merged = mergedAgentsOverride("tracked rules\n", "instructions");

		expect(merged.indexOf("tracked rules")).toBeLessThan(
			merged.indexOf("instructions"),
		);
		expect(isFabricAgentsOverride(merged)).toBe(true);
	});

	it("is just the instructions when nothing is tracked", () => {
		const merged = mergedAgentsOverride(null, "instructions");

		expect(merged).toContain("instructions");
		expect(merged.startsWith("<!--")).toBe(true);
	});

	it("does not mistake a developer's own override for Fabric's", () => {
		expect(isFabricAgentsOverride("my own override\n")).toBe(false);
	});
});
