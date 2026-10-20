import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_ACCESS_SKILL,
	INSTRUCTION_CATALOG,
} from "../src/lib/plugin/instruction-access.js";
import {
	alwaysOnFile,
	buildPlugin,
	CLAUDE_PLUGIN_MCP_SERVER,
	type InstructionFile,
	isFabricAgentsOverride,
	LIVING_MEMORY_SKILL,
	type MemoryFolders,
	mergedAgentsOverride,
	pluginNameFor,
	pluginPathFor,
	RENDER_VERSION,
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
		instructionAccess: {
			source: {
				kind: "repository",
				generation: 3,
				commitSha: "a".repeat(40),
			},
			listed: files.map((entry) => ({
				path: entry.path,
				size: entry.bytes.byteLength,
			})),
		},
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
			"instructions/source/.claude/rules/ignored.md",
			"skills/deploy/SKILL.md",
			"skills/deploy/run.sh",
			`skills/${INSTRUCTION_ACCESS_SKILL}/SKILL.md`,
			INSTRUCTION_CATALOG,
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

	it("names the plugin for the project and its MCP server just fabric, pointed at the project gateway", () => {
		const tree = build(files);

		expect(
			JSON.parse(textOf(tree, ".claude-plugin/plugin.json")),
		).toMatchObject({
			name: "fabric-23456789",
		});
		// Claude Code lists it as plugin:fabric-23456789:fabric.
		expect(JSON.parse(textOf(tree, ".mcp.json"))).toEqual({
			mcpServers: {
				[CLAUDE_PLUGIN_MCP_SERVER]: { type: "http", url: GATEWAY },
			},
		});
		expect(CLAUDE_PLUGIN_MCP_SERVER).toBe("fabric");
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

	it("supplies instruction discovery when there is no memory file", () => {
		const paths = build([file(".claude/agents/a.md", "a")]).map(
			(entry) => entry.path,
		);

		expect(paths).toContain("hooks/hooks.json");
		expect(paths).toContain("hooks/session-context.json");
		expect(textOf(build([]), "hooks/session-context.json")).toContain(
			INSTRUCTION_ACCESS_SKILL,
		);
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
		// A write the hook made has no id in the conversation: the lock holds it.
		expect(skill).toContain(".fabric/memory.lock");
		expect(skill).toContain("fabric_memory_write_status");
	});

	it("names the work-item folder convention and how to resume one: the read tool, or the local mirror", () => {
		const skill = textOf(
			build([]),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).toContain("docs/ai/specs/<work-item-id>/");
		expect(skill).toContain("fabric_memory_read");
		expect(skill).toContain("local mirror");
		// A coding tool's sign-in carries mcp:read, which the read tool accepts.
		expect(skill).not.toContain("memory:write");
	});

	it("keeps the resume guidance for a project with no folders out of the skill", () => {
		const skill = textOf(
			build([], { memory: { state: "known", ref: "main", folders: [] } }),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).not.toContain("<work-item-id>");
	});

	it("is a new render version, so installed plugins pick up the server name", () => {
		expect(RENDER_VERSION).toBeGreaterThanOrEqual(5);
	});

	it("tells Codex that the next session delivers the files, and sends it to no tool a sign-in cannot use", () => {
		const skill = textOf(
			build([], { tool: "codex" }),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill).toContain("next session starts");
		// A coding tool's MCP sign-in carries the default scopes, and
		// fabric_memory_write needs memory:write, which is never one of them.
		expect(skill).not.toContain("call the `fabric_memory_write` tool");
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

		// The plugin's CLI is not on PATH; the MCP tool is always there.
		expect(skill).toContain("fabric_memory_targets");
		expect(skill).not.toContain("fabric memory status");
	});

	it("is short", () => {
		const skill = textOf(
			build([]),
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		);

		expect(skill.length).toBeLessThan(1_500);
	});
});

describe("the plugin description", () => {
	const DESCRIPTION = `Coding instructions for Fabric project ${PROJECT} on example.com, rendered from its published instructions.`;

	it.each([
		["claude-code", ".claude-plugin/plugin.json"],
		["codex", ".codex-plugin/plugin.json"],
	] as const)(
		"names the project and the deployment for %s",
		(tool, manifest) => {
			const tree = build([], { tool });

			expect(JSON.parse(textOf(tree, manifest)).description).toBe(
				DESCRIPTION,
			);
		},
	);

	it("names the port when the deployment has one", () => {
		const tree = buildPlugin({
			tool: "codex",
			projectId: PROJECT,
			files: [],
			memory: FOLDERS,
			gatewayUrl: `https://example.com:8443/api/mcp-gateway/projects/${PROJECT}`,
			pin: "abc123def456",
			instructionAccess: {
				source: { kind: "upload", digest: null },
				listed: [],
			},
		});

		expect(
			JSON.parse(textOf(tree, ".codex-plugin/plugin.json")).description,
		).toContain("on example.com:8443,");
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
			".codex-plugin/plugin.json",
			".mcp.json",
			"agents/reviewer.md",
			"instructions/AGENTS.md",
			"skills/deploy/SKILL.md",
			`skills/${INSTRUCTION_ACCESS_SKILL}/SKILL.md`,
			INSTRUCTION_CATALOG,
			`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		]);
		// Codex reads the manifest only from .codex-plugin/, and loads the MCP
		// file only when the manifest points at it.
		expect(
			JSON.parse(textOf(tree, ".codex-plugin/plugin.json")),
		).toMatchObject({
			name: "fabric-23456789",
			version: "0.0.0-abc123def456",
			skills: "./skills/",
			mcpServers: "./.mcp.json",
		});
		expect(JSON.parse(textOf(tree, ".mcp.json"))).toEqual({
			mcpServers: {
				"fabric-23456789": { type: "http", url: GATEWAY },
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
