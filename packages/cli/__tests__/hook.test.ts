/**
 * The SessionStart hook merge (Fizzy #2539).
 *
 * `.claude/settings.local.json` is the developer's own file. Everything in it
 * survives, a second run replaces rather than stacks, and a file we cannot
 * parse is refused rather than rewritten — a half-finished edit is not
 * something to discard.
 *
 * Matching is on parsed argv tokens (review round 1, finding 13): `--project
 * abc` must not match `--project abc-extra`, `--project=abc` is the same
 * request written differently, and a file that has accumulated duplicates
 * must come out with exactly one entry.
 */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertKeyStaysOutside,
	buildHookCommand,
	buildLessonPromptCommand,
	mergeCommandHook,
	mergeSessionStartHook,
	removeCommandHook,
} from "../src/lib/instructions/hook.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";

async function makeTree(): Promise<string> {
	return resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-hook-")),
	);
}

async function writeSettings(root: string, body: string): Promise<string> {
	const file = path.join(root, ".claude", "settings.local.json");
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, body, "utf8");
	return file;
}

async function readSettings(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(
		await readFile(
			path.join(root, ".claude", "settings.local.json"),
			"utf8",
		),
	);
}

function commandsIn(settings: unknown): string[] {
	const groups = (
		settings as {
			hooks: { SessionStart: { hooks: { command: string }[] }[] };
		}
	).hooks.SessionStart;
	return groups.flatMap((group) => group.hooks.map((hook) => hook.command));
}

function stopCommandsIn(settings: unknown): string[] {
	const groups = (
		settings as {
			hooks?: { Stop?: { hooks: { command: string }[] }[] };
		}
	).hooks?.Stop;
	return (groups ?? []).flatMap((group) =>
		group.hooks.map((hook) => hook.command),
	);
}

function merge(root: string, projectId: string, apply = false) {
	return mergeSessionStartHook({
		root,
		projectId,
		command: buildHookCommand(projectId, apply),
	});
}

type HookTool = "claude-code" | "codex";

function hookFileFor(root: string, tool: HookTool): string {
	return path.join(
		root,
		tool === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json",
	);
}

async function writeHookFile(
	root: string,
	tool: HookTool,
	body: string,
): Promise<string> {
	const file = hookFileFor(root, tool);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, body, "utf8");
	return file;
}

function mergeForTool(root: string, tool: HookTool) {
	return mergeSessionStartHook({
		root,
		projectId: "project-1",
		command: buildHookCommand("project-1", false),
		tool,
	});
}

describe("buildHookCommand", () => {
	it("names the project and never the key", () => {
		expect(buildHookCommand("project-1", false)).toBe(
			"fabric instructions check --project project-1 --hook",
		);
		expect(buildHookCommand("project-1", true)).toBe(
			"fabric instructions sync --project project-1 --hook",
		);
	});

	/**
	 * Review round 3, finding 3. These commands read no stored default
	 * context, so a slug supplied once on the `init` command line has nowhere
	 * else to live: leaving it out would install a hook that binds differently
	 * from the command that created it.
	 */
	it("carries an explicit --org through to the hook", () => {
		expect(buildHookCommand("project-1", false, "example-org")).toBe(
			"fabric instructions check --project project-1 --org example-org --hook",
		);
	});

	it("still matches its own hook when an --org is present", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false, "example-org"),
		});

		const second = await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", true, "example-org"),
		});

		expect(second.replacedCount).toBe(1);
		expect(commandsIn(await readSettings(root))).toEqual([
			"fabric instructions sync --project project-1 --org example-org --hook",
		]);
	});
});

/**
 * Review round 3, finding 8. Top-level JSON was refused carefully and these
 * were not: a `hooks` that is not an object, or a `SessionStart` that is not
 * an array, was replaced with a freshly built one — discarding whatever the
 * developer had there.
 */
describe("malformed nested shapes", () => {
	it.each([
		['{"hooks": ["custom"]}', /"hooks" is not an object/],
		[
			'{"hooks": {"SessionStart": "nope"}}',
			/SessionStart" is not an array/,
		],
		[
			'{"hooks": {"SessionStart": ["nope"]}}',
			/SessionStart\[0\]" is not an object/,
		],
		[
			'{"hooks": {"SessionStart": [{"hooks": "nope"}]}}',
			/SessionStart\[0\]\.hooks" is not an array/,
		],
	])("refuses %s and leaves the file untouched", async (body, matcher) => {
		const root = await makeTree();
		const file = await writeSettings(root, body);

		await expect(merge(root, "project-1")).rejects.toThrow(matcher);
		expect(await readFile(file, "utf8")).toBe(body);
	});

	it("still accepts a file with no hooks key at all", async () => {
		const root = await makeTree();
		await writeSettings(root, JSON.stringify({ permissions: {} }));

		await expect(merge(root, "project-1")).resolves.toMatchObject({
			replacedCount: 0,
		});
	});
});

describe("existing hook config reads", () => {
	it.each(["claude-code", "codex"] as const)(
		"refuses a symlinked existing %s config without reading or rewriting its target",
		async (tool) => {
			const root = await makeTree();
			const outside = path.join(await makeTree(), "hooks.json");
			const body = '{"hooks":{"SessionStart":[]}}';
			await writeFile(outside, body, "utf8");
			const file = hookFileFor(root, tool);
			await mkdir(path.dirname(file), { recursive: true });
			await symlink(outside, file, "file");

			await expect(mergeForTool(root, tool)).rejects.toThrow(
				/left untouched/,
			);
			expect(await readFile(outside, "utf8")).toBe(body);
		},
	);

	it.each(["claude-code", "codex"] as const)(
		"refuses an oversized existing %s config before rewriting it",
		async (tool) => {
			const root = await makeTree();
			const body = JSON.stringify({ padding: "x".repeat(1_048_577) });
			const file = await writeHookFile(root, tool, body);

			await expect(mergeForTool(root, tool)).rejects.toThrow(
				/too large.*left untouched/,
			);
			expect(await readFile(file, "utf8")).toBe(body);
		},
	);

	it.each([
		["claude-code", ""],
		["claude-code", " \n\t"],
		["codex", ""],
		["codex", " \n\t"],
	] as const)(
		"refuses an existing %s config containing only whitespace",
		async (tool, body) => {
			const root = await makeTree();
			const file = await writeHookFile(root, tool, body);

			await expect(mergeForTool(root, tool)).rejects.toThrow(
				/not valid JSON/,
			);
			expect(await readFile(file, "utf8")).toBe(body);
		},
	);
});

describe("mergeSessionStartHook", () => {
	it("merges a Codex hook without disturbing unrelated events or matcher groups", async () => {
		const root = await makeTree();
		const file = path.join(root, ".codex", "hooks.json");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({
				description: "Personal hooks",
				hooks: {
					SessionStart: [
						{
							matcher: "startup|resume",
							hooks: [
								{ type: "command", command: "echo keep" },
								{
									type: "command",
									command:
										"fabric instructions sync --project project-1 --hook",
								},
							],
						},
					],
					PreToolUse: [{ matcher: "Bash", hooks: [] }],
				},
			}),
			"utf8",
		);

		const result = await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false),
			tool: "codex",
		});

		expect(result.settingsPath).toBe(file);
		const hooks = JSON.parse(await readFile(file, "utf8"));
		expect(hooks.description).toBe("Personal hooks");
		expect(hooks.hooks.PreToolUse).toEqual([
			{ matcher: "Bash", hooks: [] },
		]);
		expect(hooks.hooks.SessionStart).toEqual([
			{
				matcher: "startup|resume",
				hooks: [{ type: "command", command: "echo keep" }],
			},
			{
				hooks: [
					{
						type: "command",
						command:
							"fabric instructions check --project project-1 --hook",
						timeout: 15,
					},
				],
			},
		]);
	});

	it("creates the file when there is none", async () => {
		const root = await makeTree();

		const result = await merge(root, "project-1");

		expect(result.createdFile).toBe(true);
		expect(result.replacedCount).toBe(0);
		expect(await readSettings(root)).toEqual({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command:
									"fabric instructions check --project project-1 --hook",
								timeout: 15,
							},
						],
					},
				],
			},
		});
	});

	it("never writes the shared settings.json", async () => {
		const root = await makeTree();

		const result = await merge(root, "project-1");

		expect(result.settingsPath.endsWith("settings.local.json")).toBe(true);
		await expect(
			readFile(path.join(root, ".claude", "settings.json"), "utf8"),
		).rejects.toThrow();
	});

	/**
	 * The hook write used to bypass the path guard entirely, so `.claude -> ..`
	 * wrote the settings file outside the checkout.
	 */
	it("refuses to write through a symlinked .claude", async () => {
		const root = await makeTree();
		const outside = await makeTree();
		await symlink(outside, path.join(root, ".claude"), "dir");

		await expect(merge(root, "project-1")).rejects.toThrow(/symlink/);
		expect(await readdir(outside)).toEqual([]);
	});

	it("preserves unrelated keys and unrelated hooks", async () => {
		const root = await makeTree();
		await writeSettings(
			root,
			JSON.stringify({
				permissions: { allow: ["Bash(ls:*)"] },
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: "echo hello" }] },
					],
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [{ type: "command", command: "guard" }],
						},
					],
				},
			}),
		);

		await merge(root, "project-1");

		const settings = (await readSettings(root)) as {
			permissions: unknown;
			hooks: { PreToolUse: unknown };
		};
		expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
		expect(settings.hooks.PreToolUse).toEqual([
			{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] },
		]);
		expect(commandsIn(settings)).toEqual([
			"echo hello",
			"fabric instructions check --project project-1 --hook",
		]);
	});

	it("replaces its own entry rather than duplicating it", async () => {
		const root = await makeTree();
		await merge(root, "project-1");

		const second = await merge(root, "project-1", true);

		expect(second.replacedCount).toBe(1);
		expect(commandsIn(await readSettings(root))).toEqual([
			"fabric instructions sync --project project-1 --hook",
		]);
	});

	it("keeps another project's hook alongside", async () => {
		const root = await makeTree();
		await merge(root, "project-1");

		await merge(root, "project-2");

		expect(commandsIn(await readSettings(root))).toEqual([
			"fabric instructions check --project project-1 --hook",
			"fabric instructions check --project project-2 --hook",
		]);
	});

	/**
	 * Substring matching said `--project abc` and `--project abc-extra` were
	 * the same hook, so configuring one project silently deleted another's.
	 */
	it("does not match a project id that merely starts the same", async () => {
		const root = await makeTree();
		await merge(root, "abc-extra");

		const result = await merge(root, "abc");

		expect(result.replacedCount).toBe(0);
		expect(commandsIn(await readSettings(root))).toEqual([
			"fabric instructions check --project abc-extra --hook",
			"fabric instructions check --project abc --hook",
		]);
	});

	it("recognises the --project=<id> spelling as its own", async () => {
		const root = await makeTree();
		await writeSettings(
			root,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command:
										"fabric instructions check --project=abc --hook",
								},
							],
						},
					],
				},
			}),
		);

		const result = await merge(root, "abc");

		expect(result.replacedCount).toBe(1);
		expect(commandsIn(await readSettings(root))).toEqual([
			"fabric instructions check --project abc --hook",
		]);
	});

	it("collapses duplicates that accumulated across groups", async () => {
		const root = await makeTree();
		const ours = {
			type: "command",
			command: "fabric instructions check --project abc --hook",
		};
		await writeSettings(
			root,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								ours,
								{ type: "command", command: "echo one" },
							],
						},
						{ hooks: [ours] },
						{
							hooks: [
								{
									type: "command",
									command:
										"fabric instructions sync --project=abc --hook",
								},
							],
						},
					],
				},
			}),
		);

		const result = await merge(root, "abc");

		expect(result.replacedCount).toBe(3);
		expect(commandsIn(await readSettings(root))).toEqual([
			"echo one",
			"fabric instructions check --project abc --hook",
		]);
	});

	it("leaves a group that was already empty exactly as it was", async () => {
		const root = await makeTree();
		await writeSettings(
			root,
			JSON.stringify({
				hooks: { SessionStart: [{ matcher: "startup", hooks: [] }] },
			}),
		);

		await merge(root, "project-1");

		const settings = (await readSettings(root)) as {
			hooks: { SessionStart: unknown[] };
		};
		expect(settings.hooks.SessionStart[0]).toEqual({
			matcher: "startup",
			hooks: [],
		});
	});

	/**
	 * Review round 2, finding 9. Commander resolves a repeated option to the
	 * LAST value, while reading the first token answers the first. Either
	 * reading makes this matcher wrong about someone's hook, so a command with
	 * two of them is left exactly as it is.
	 */
	it.each([
		["fabric instructions check --project other --project target --hook"],
		["fabric instructions check --project=other --project target --hook"],
		["fabric instructions sync --project target --project=target --hook"],
	])(
		"leaves %s alone rather than guessing which project it means",
		async (command) => {
			const root = await makeTree();
			await writeSettings(
				root,
				JSON.stringify({
					hooks: {
						SessionStart: [
							{ hooks: [{ type: "command", command }] },
						],
					},
				}),
			);

			const forOther = await merge(root, "other");
			const forTarget = await merge(root, "target");

			expect(forOther.replacedCount).toBe(0);
			expect(forTarget.replacedCount).toBe(0);
			expect(commandsIn(await readSettings(root))).toContain(command);
		},
	);

	it("ignores a command that is not ours", async () => {
		const root = await makeTree();
		await writeSettings(
			root,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command:
										"other-tool instructions check --project abc",
								},
								{
									type: "command",
									command:
										"fabric instructions push --project abc",
								},
							],
						},
					],
				},
			}),
		);

		const result = await merge(root, "abc");

		expect(result.replacedCount).toBe(0);
		expect(commandsIn(await readSettings(root))).toHaveLength(3);
	});

	it("refuses invalid JSON without clobbering it", async () => {
		const root = await makeTree();
		const file = await writeSettings(root, "{ half an edit");

		await expect(merge(root, "project-1")).rejects.toThrow(
			/not valid JSON/,
		);

		expect(await readFile(file, "utf8")).toBe("{ half an edit");
	});

	it("refuses a settings file that is not a JSON object", async () => {
		const root = await makeTree();
		await writeSettings(root, "[1, 2, 3]");

		await expect(merge(root, "project-1")).rejects.toThrow(
			/does not contain a JSON object/,
		);
	});

	it("writes pretty JSON with LF endings", async () => {
		const root = await makeTree();
		await merge(root, "project-1");

		const raw = await readFile(
			path.join(root, ".claude", "settings.local.json"),
			"utf8",
		);
		expect(raw).not.toContain("\r");
		expect(raw.endsWith("}\n")).toBe(true);
	});
});

describe("mergeCommandHook across events", () => {
	/**
	 * A `lesson-prompt` entry must never be touched by the `SessionStart`
	 * merge, and a `check`/`sync` entry must never be touched by the `Stop`
	 * merge — even though the two events already live under different JSON
	 * keys, so a bug here would have to reach across `hooks.SessionStart` and
	 * `hooks.Stop` to matter at all.
	 */
	it("adding a Stop hook does not disturb an existing SessionStart hook", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false),
		});

		await mergeCommandHook({
			root,
			projectId: "project-1",
			command: buildLessonPromptCommand("project-1"),
			event: "Stop",
		});

		const settings = await readSettings(root);
		expect(commandsIn(settings)).toEqual([
			"fabric instructions check --project project-1 --hook",
		]);
		expect(stopCommandsIn(settings)).toEqual([
			"fabric instructions lesson-prompt --project project-1 --hook",
		]);
	});

	it("adding a SessionStart hook does not disturb an existing Stop hook", async () => {
		const root = await makeTree();
		await mergeCommandHook({
			root,
			projectId: "project-1",
			command: buildLessonPromptCommand("project-1"),
			event: "Stop",
		});

		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false),
		});

		const settings = await readSettings(root);
		expect(commandsIn(settings)).toEqual([
			"fabric instructions check --project project-1 --hook",
		]);
		expect(stopCommandsIn(settings)).toEqual([
			"fabric instructions lesson-prompt --project project-1 --hook",
		]);
	});
});

describe("removeCommandHook", () => {
	it("removes only the matching subcommand's entries", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false),
		});
		await mergeCommandHook({
			root,
			projectId: "project-1",
			command: buildLessonPromptCommand("project-1"),
			event: "Stop",
		});

		const result = await removeCommandHook({
			root,
			projectId: "project-1",
			subcommand: "lesson-prompt",
			event: "Stop",
		});

		expect(result.changed).toBe(true);
		const settings = await readSettings(root);
		expect(stopCommandsIn(settings)).toEqual([]);
		expect(commandsIn(settings)).toEqual([
			"fabric instructions check --project project-1 --hook",
		]);
	});

	it("returns false and does not create the file when nothing matches", async () => {
		const root = await makeTree();

		const result = await removeCommandHook({
			root,
			projectId: "project-1",
			subcommand: "lesson-prompt",
			event: "Stop",
		});

		expect(result.changed).toBe(false);
		await expect(
			readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
		).rejects.toThrow();
	});

	it("leaves an existing file byte-for-byte untouched when nothing matches", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false),
		});
		const settingsFile = path.join(root, ".claude", "settings.local.json");
		const before = await readFile(settingsFile, "utf8");

		const result = await removeCommandHook({
			root,
			projectId: "project-1",
			subcommand: "lesson-prompt",
			event: "Stop",
		});

		expect(result.changed).toBe(false);
		expect(await readFile(settingsFile, "utf8")).toBe(before);
	});

	it("does not remove another project's matching subcommand", async () => {
		const root = await makeTree();
		await mergeCommandHook({
			root,
			projectId: "project-2",
			command: buildLessonPromptCommand("project-2"),
			event: "Stop",
		});

		const result = await removeCommandHook({
			root,
			projectId: "project-1",
			subcommand: "lesson-prompt",
			event: "Stop",
		});

		expect(result.changed).toBe(false);
		const settings = await readSettings(root);
		expect(stopCommandsIn(settings)).toEqual([
			"fabric instructions lesson-prompt --project project-2 --hook",
		]);
	});

	it("never leaves an empty-object group behind", async () => {
		const root = await makeTree();
		await mergeCommandHook({
			root,
			projectId: "project-1",
			command: buildLessonPromptCommand("project-1"),
			event: "Stop",
		});

		await removeCommandHook({
			root,
			projectId: "project-1",
			subcommand: "lesson-prompt",
			event: "Stop",
		});

		const settings = (await readSettings(root)) as {
			hooks: { Stop: unknown[] };
		};
		expect(settings.hooks.Stop).toEqual([]);
	});
});

describe("assertKeyStaysOutside", () => {
	it("allows a config file outside the destination", async () => {
		const root = await makeTree();
		const elsewhere = await makeTree();

		await expect(
			assertKeyStaysOutside(root, path.join(elsewhere, "config.json")),
		).resolves.toBeUndefined();
	});

	it("refuses a config file inside the destination", async () => {
		const root = await makeTree();

		await expect(
			assertKeyStaysOutside(
				root,
				path.join(root, ".config", "fabricai", "config.json"),
			),
		).rejects.toThrow(/live credential in the repository/);
	});

	/**
	 * Lexical comparison missed this entirely: the config path is outside the
	 * checkout as a string and inside it as a file.
	 */
	it("refuses a config path that reaches the destination through a symlink", async () => {
		const root = await makeTree();
		const elsewhere = await makeTree();
		await mkdir(path.join(root, "cfg"));
		const link = path.join(elsewhere, "cfg-link");
		await symlink(path.join(root, "cfg"), link, "dir");

		await expect(
			assertKeyStaysOutside(root, path.join(link, "config.json")),
		).rejects.toThrow(/live credential in the repository/);
	});
});
