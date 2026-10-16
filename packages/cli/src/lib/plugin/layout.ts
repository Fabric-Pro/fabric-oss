/**
 * The tree of a coding-tool plugin built from a project's instructions.
 *
 * Pure: it is handed the instruction files and the facts about the project and
 * returns the files to write, so every mapping is testable without a disk, and
 * the same inputs always give the same bytes (a Claude Code `command` plugin is
 * versioned by a hash of its files, so output that varies churns the version).
 *
 * The instructions of a project are the files a developer would have cloned:
 * `.claude/skills/*`, `.claude/agents/*`, `.claude/commands/*`, a root
 * `CLAUDE.md` or `AGENTS.md`, and so on. A plugin carries the parts a coding
 * tool loads from a plugin, and says where they went:
 *
 *   .claude/skills/<name>/**   ->  skills/<name>/**
 *   .claude/agents/<file>.md   ->  agents/<file>.md
 *   .claude/commands/**        ->  commands/**
 *   CLAUDE.md (else AGENTS.md) ->  a SessionStart hook that hands it to the
 *                                  session as context, and instructions/<file>
 *
 * A plugin has no slot for a project's memory file, so the hook is how
 * `CLAUDE.md` reaches the session. Claude Code truncates a hook's output past
 * 10,000 characters, so a longer file is cut at a line break by Fabric, with a
 * notice that says where the whole file is, rather than by the tool in the
 * middle of a sentence.
 */

export interface InstructionFile {
	/** Relative POSIX path inside the instructions tree. */
	path: string;
	bytes: Uint8Array;
	/** POSIX permission bits when the source recorded them. */
	mode?: number | null;
}

/** What a rendered plugin holds: a path (POSIX, relative) and its bytes. */
export interface PluginFile {
	path: string;
	bytes: Uint8Array;
	mode: number;
}

export type PluginTool = "claude-code" | "codex";

/** Where a write folder lands: a pull request or a direct commit. */
interface MemoryFolder {
	folder: string;
	mode: "PULL_REQUEST" | "DIRECT_PUSH";
}

/** What the plugin tells the agent about the project's write folders. */
export type MemoryFolders =
	| { state: "known"; ref: string | null; folders: MemoryFolder[] }
	| { state: "unavailable" };

/** Claude Code cuts a hook's output at 10,000 characters. */
export const SESSION_CONTEXT_LIMIT = 10_000;

/** Bumped when the layout changes, so the same pin renders to a new folder. */
export const RENDER_VERSION = 1;

/**
 * The hook's command: print the pre-rendered context. `CLAUDE_PLUGIN_ROOT` is a
 * variable of the shell Claude Code runs the hook in, expanded there, so the
 * command needs no node and no path of ours.
 */
const SESSION_CONTEXT_COMMAND = `cat "\${CLAUDE_PLUGIN_ROOT}/hooks/session-context.json"`;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: false });

export const LIVING_MEMORY_SKILL = "fabric-living-memory";

/** The memory file a project keeps for its agents, in order of preference. */
const ALWAYS_ON_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
type AlwaysOnFile = (typeof ALWAYS_ON_FILES)[number];

/**
 * A stable plugin name for a project. A project id is a long opaque string; the
 * tail is the part that differs between projects.
 */
export function pluginNameFor(projectId: string): string {
	const tail = projectId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(-8);
	return `fabric-${tail === "" ? "project" : tail}`;
}

function bytesOf(text: string): Uint8Array {
	return ENCODER.encode(text);
}

function textOf(bytes: Uint8Array): string {
	return DECODER.decode(bytes);
}

function isExecutable(mode: number | null | undefined): boolean {
	return typeof mode === "number" && (mode & 0o111) !== 0;
}

function fileModeOf(mode: number | null | undefined): number {
	return isExecutable(mode) ? 0o755 : 0o644;
}

/**
 * Where an instruction file goes in the plugin, or `null` when a plugin has no
 * place for it. Folder names are matched without regard to case, because
 * guild-shaped trees keep `Skills/` and `Agents/` at the root; the names under
 * them keep their case.
 */
export function pluginPathFor(instructionPath: string): string | null {
	const segments = instructionPath.split("/");
	const first = segments[0]?.toLowerCase();
	const rest = first === ".claude" ? segments.slice(1) : segments;
	const folder = rest[0]?.toLowerCase();
	if (rest.length < 2) {
		return null;
	}
	const below = rest.slice(1);
	switch (folder) {
		case "skills":
			return below.length >= 2 ? `skills/${below.join("/")}` : null;
		case "agents":
			return below.length === 1 && below[0]?.toLowerCase().endsWith(".md")
				? `agents/${below[0]}`
				: null;
		case "commands":
			return `commands/${below.join("/")}`;
		default:
			return null;
	}
}

/**
 * The always-on memory file of the tree, or `null` when it has none. Claude
 * Code reads `CLAUDE.md` first and Codex `AGENTS.md`; the other is the
 * fallback, so a tree with one file serves both.
 */
export function alwaysOnFile(
	files: readonly InstructionFile[],
	tool: PluginTool = "claude-code",
): { file: AlwaysOnFile; text: string } | null {
	const order: readonly AlwaysOnFile[] =
		tool === "codex" ? ["AGENTS.md", "CLAUDE.md"] : ALWAYS_ON_FILES;
	for (const name of order) {
		const found = files.find((entry) => entry.path === name);
		if (found !== undefined) {
			const text = textOf(found.bytes);
			if (text.trim() !== "") {
				return { file: name, text };
			}
		}
	}
	return null;
}

/**
 * Where a session finds the whole file when it was cut. Claude Code unpacks a
 * plugin under its cache, `<marketplace>/<plugin>/<version>/`, and the
 * version is a hash that moves, so the notice names the folder pattern.
 */
function truncationNotice(file: AlwaysOnFile, pluginName: string): string {
	return `\n\n[Fabric: this file is longer than the ${SESSION_CONTEXT_LIMIT.toLocaleString("en-US")} characters a session start can carry, so it was cut here. Read the rest in full before relying on it: instructions/${file} inside the ${pluginName} plugin, for example ~/.claude/plugins/cache/${pluginName}/${pluginName}/*/instructions/${file}]`;
}

/**
 * The text a SessionStart hook hands to the session: the file itself, or its
 * start and a notice when it is too long. Never longer than the limit.
 */
export function sessionContext(
	file: AlwaysOnFile,
	text: string,
	pluginName: string,
): string {
	const heading = `Coding instructions for this project (${file}, from Fabric):\n\n`;
	const whole = heading + text;
	if (whole.length <= SESSION_CONTEXT_LIMIT) {
		return whole;
	}
	const notice = truncationNotice(file, pluginName);
	const room = SESSION_CONTEXT_LIMIT - heading.length - notice.length;
	let cut = text.slice(0, Math.max(0, room));
	const lineBreak = cut.lastIndexOf("\n");
	if (lineBreak > room * 0.5) {
		cut = cut.slice(0, lineBreak);
	}
	// A cut through a surrogate pair would leave half a character.
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		cut = cut.slice(0, -1);
	}
	return heading + cut.trimEnd() + notice;
}

function json(value: unknown): Uint8Array {
	return bytesOf(`${JSON.stringify(value, null, 2)}\n`);
}

function folderLine(folder: MemoryFolder): string {
	const where =
		folder.mode === "DIRECT_PUSH"
			? "committed straight to the project's synced branch"
			: "sent as a pull request for a person to review";
	return `- \`${folder.folder}/\` -- ${where}`;
}

/**
 * The skill that tells an agent where its memory files go. Short on purpose:
 * it is read whenever an agent is about to write a spec, a task list or a note.
 */
function livingMemorySkill(memory: MemoryFolders, tool: PluginTool): string {
	const delivery =
		tool === "claude-code"
			? "Fabric delivers them: a hook sends new and changed files when your turn ends, and brings other people's changes in when a session starts. Do not run git for these files."
			: "Fabric delivers them when the next session starts (this tool has no end-of-turn hook). To deliver sooner, call the `fabric_memory_write` tool of the Fabric MCP server. Do not run git for these files.";
	const header = [
		"---",
		`name: ${LIVING_MEMORY_SKILL}`,
		"description: Where to write specs, task breakdowns and working notes for this project so they reach its repository through Fabric. Use it whenever you are about to save planning or memory files.",
		"---",
		"",
		"# Fabric Living Memory",
		"",
	];
	let body: string[];
	if (memory.state === "unavailable") {
		body = [
			"The list of this project's memory folders could not be read when this plugin was built. Run `fabric memory status` to see them, and do not save memory files until you know the folder.",
		];
	} else if (memory.folders.length === 0) {
		body = [
			"This project has no memory folders yet, so there is nowhere to save memory files. A project admin adds them in the project's Context tab. Until then, keep notes in the conversation and do not save them as files.",
		];
	} else {
		body = [
			"Write specs, task breakdowns and working notes as plain files with your normal file tools. Save them only in these folders, relative to the project root:",
			"",
			...memory.folders.map(folderLine),
			"",
			delivery,
			"",
			"Never save memory files anywhere else. A file in a pull-request folder is not part of the project's Living Memory until the pull request is merged.",
		];
	}
	return `${[...header, ...body].join("\n")}\n`;
}

function descriptionFor(): string {
	return "Coding instructions for a Fabric project, rendered from the project's published instructions.";
}

/** The project's MCP gateway as a plugin's MCP configuration. */
function mcpConfiguration(
	tool: PluginTool,
	serverName: string,
	url: string,
): Uint8Array {
	return json({
		mcpServers: {
			[serverName]: {
				type: tool === "codex" ? "streamable-http" : "http",
				url,
			},
		},
	});
}

export interface PluginInputs {
	tool: PluginTool;
	projectId: string;
	files: readonly InstructionFile[];
	memory: MemoryFolders;
	/** The project's MCP gateway URL. */
	gatewayUrl: string;
	/** Distinguishes one render from another in the manifest of a Codex plugin. */
	pin: string;
}

/**
 * The plugin, as sorted files. Instruction files a plugin has no place for are
 * left out; the memory file is both the hook's source and, whole, a file of the
 * plugin.
 */
export function buildPlugin(inputs: PluginInputs): PluginFile[] {
	const name = pluginNameFor(inputs.projectId);
	const out = new Map<string, PluginFile>();
	const put = (path: string, bytes: Uint8Array, mode = 0o644) => {
		out.set(path, { path, bytes, mode });
	};

	for (const file of [...inputs.files].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	)) {
		const target = pluginPathFor(file.path);
		if (target !== null) {
			put(target, file.bytes, fileModeOf(file.mode));
		}
	}

	// The generated skill wins a name clash: an agent must be told one thing.
	put(
		`skills/${LIVING_MEMORY_SKILL}/SKILL.md`,
		bytesOf(livingMemorySkill(inputs.memory, inputs.tool)),
	);
	for (const path of [...out.keys()]) {
		if (
			path.startsWith(`skills/${LIVING_MEMORY_SKILL}/`) &&
			path !== `skills/${LIVING_MEMORY_SKILL}/SKILL.md`
		) {
			out.delete(path);
		}
	}

	if (inputs.tool === "claude-code") {
		put(
			".claude-plugin/plugin.json",
			json({
				name,
				description: descriptionFor(),
				author: { name: "Fabric" },
			}),
		);
		put(
			".mcp.json",
			mcpConfiguration("claude-code", name, inputs.gatewayUrl),
		);
		const always = alwaysOnFile(inputs.files);
		if (always !== null) {
			put(`instructions/${always.file}`, bytesOf(always.text));
			put(
				"hooks/session-context.json",
				json({
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: sessionContext(
							always.file,
							always.text,
							name,
						),
					},
				}),
			);
			put(
				"hooks/hooks.json",
				json({
					hooks: {
						SessionStart: [
							{
								hooks: [
									{
										type: "command",
										command: SESSION_CONTEXT_COMMAND,
									},
								],
							},
						],
					},
				}),
			);
		}
	} else {
		put(
			"plugin.json",
			json({
				name,
				version: `0.0.0-${inputs.pin}`,
				description: descriptionFor(),
			}),
		);
		put("mcp.json", mcpConfiguration("codex", name, inputs.gatewayUrl));
	}

	return [...out.values()].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

const AGENTS_BEGIN = "<!-- fabric-instructions:begin -->";
const AGENTS_END = "<!-- fabric-instructions:end -->";

/**
 * The text of a Codex `AGENTS.override.md`: the project's tracked `AGENTS.md`
 * (when it has one) and then the instructions, so the override never hides what
 * the repository itself says. Fabric's part sits between markers so a reader
 * can tell whose it is. Built from the tracked file, never from a previous
 * override, so it does not grow.
 */
export function mergedAgentsOverride(
	tracked: string | null,
	instructions: string,
): string {
	const parts: string[] = [];
	if (tracked !== null && tracked.trim() !== "") {
		parts.push(tracked.trimEnd());
	}
	parts.push(`${AGENTS_BEGIN}\n${instructions.trimEnd()}\n${AGENTS_END}`);
	return `${parts.join("\n\n")}\n`;
}

/** Is this the override Fabric wrote? Anything else at that path is the developer's. */
export function isFabricAgentsOverride(text: string): boolean {
	return text.includes(AGENTS_BEGIN) && text.includes(AGENTS_END);
}
