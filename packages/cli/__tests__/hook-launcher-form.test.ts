/**
 * A session hook has to start the CLI on a machine that never installed it.
 *
 * The line `npx -y <tarball> instructions init` leaves no `fabric` on PATH, so
 * `init` keeps a copy of the served build and the hook runs `node <that file>`.
 * The matcher that decides which hook is ours, and so which one `init`
 * replaces and `doctor` accepts, has to read that form as well as the
 * `fabric …` form earlier versions wrote, including a path with a space in it.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildHookArguments,
	buildHookCommand,
	buildLessonPromptCommand,
	findSessionStartHooks,
	hookArgumentsOf,
	mergeCommandHook,
	mergeSessionStartHook,
	parseHookCommand,
	removeCommandHook,
} from "../src/lib/instructions/hook.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";

const COPY = "D:/config/Config/cli/http-localhost-3001/fabric.mjs";
const SPACED_COPY = "D:/Dev Config/Config/cli/https-example.com/fabric.mjs";
const NODE = `node ${COPY}`;
const NODE_SPACED = `node "${SPACED_COPY}"`;

async function makeTree(): Promise<string> {
	return resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-hook-launcher-")),
	);
}

async function settingsCommands(root: string): Promise<string[]> {
	const settings = JSON.parse(
		await readFile(
			path.join(root, ".claude", "settings.local.json"),
			"utf8",
		),
	) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
	return settings.hooks.SessionStart.flatMap((group) =>
		group.hooks.map((hook) => hook.command),
	);
}

describe("the hook command with a launcher", () => {
	it("starts with a bare `node`, then the file, then the same arguments as ever", () => {
		const command = buildHookCommand(
			"cm0example0project",
			false,
			undefined,
			{ baseUrl: "http://localhost:3001" },
			NODE,
		);

		expect(command).toBe(
			`node ${COPY} instructions check --project cm0example0project --base-url http://localhost:3001 --hook`,
		);
		expect(command.split(" ")[0]).toBe("node");
	});

	it("is `fabric` when no launcher is given, as before", () => {
		expect(buildHookCommand("project-1", true)).toBe(
			"fabric instructions sync --project project-1 --hook",
		);
	});

	it("carries the launcher into the lesson-capture command too", () => {
		expect(buildLessonPromptCommand("project-1", "example-org", NODE)).toBe(
			`node ${COPY} instructions lesson-prompt --project project-1 --org example-org --hook`,
		);
	});
});

describe("parseHookCommand", () => {
	it.each([
		["fabric", "fabric instructions check --project p --hook", "global"],
		["a copy", `${NODE} instructions check --project p --hook`, "script"],
		[
			"a copy at a path with a space",
			`${NODE_SPACED} instructions check --project p --hook`,
			"script",
		],
	])("reads %s", (_label, command, kind) => {
		const parsed = parseHookCommand(command);

		expect(parsed?.launcher.kind).toBe(kind);
		expect(parsed?.args).toEqual([
			"instructions",
			"check",
			"--project",
			"p",
			"--hook",
		]);
	});

	it("takes the path out of the quotes", () => {
		expect(
			parseHookCommand(`${NODE_SPACED} instructions check`)?.launcher,
		).toEqual({ kind: "script", path: SPACED_COPY });
	});

	it("reads a Windows path spelled with backslashes", () => {
		expect(
			parseHookCommand(
				"node D:\\config\\Config\\cli\\http-localhost-3001\\fabric.mjs instructions check",
			)?.launcher,
		).toEqual({
			kind: "script",
			path: "D:\\config\\Config\\cli\\http-localhost-3001\\fabric.mjs",
		});
	});

	it.each([
		["another node script", "node D:/tools/other.mjs instructions check"],
		["node alone", "node"],
		[
			"a quote that never closes",
			`node "${SPACED_COPY} instructions check`,
		],
		["some other program", "pnpm instructions check --project p"],
		["an empty command", "   "],
	])("does not read %s as ours", (_label, command) => {
		expect(parseHookCommand(command)).toBeNull();
	});

	it("gives the same arguments behind either launcher", () => {
		const args = buildHookArguments("project-1", true, "example-org", {
			baseUrl: "https://example.com",
		});

		expect(hookArgumentsOf(`fabric ${args}`)).toBe(args);
		expect(hookArgumentsOf(`${NODE} ${args}`)).toBe(args);
		expect(hookArgumentsOf(`${NODE_SPACED} ${args}`)).toBe(args);
	});
});

describe("init replaces a hook of either form with exactly one", () => {
	it("replaces the `fabric` form with the copy form", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false),
		});

		const second = await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false, undefined, {}, NODE),
		});

		expect(second.replacedCount).toBe(1);
		expect(await settingsCommands(root)).toEqual([
			`${NODE} instructions check --project project-1 --hook`,
		]);
	});

	it("replaces a copy form whose path has a space, and a second run stays at one", async () => {
		const root = await makeTree();
		const write = () =>
			mergeSessionStartHook({
				root,
				projectId: "project-1",
				command: buildHookCommand(
					"project-1",
					true,
					undefined,
					{},
					NODE_SPACED,
				),
			});
		await write();

		const second = await write();

		expect(second.replacedCount).toBe(1);
		expect(await settingsCommands(root)).toEqual([
			`${NODE_SPACED} instructions sync --project project-1 --hook`,
		]);
	});

	it("leaves another project's hook alone, whichever form it is in", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-10",
			command: buildHookCommand("project-10", false, undefined, {}, NODE),
		});

		const mine = await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false, undefined, {}, NODE),
		});

		expect(mine.replacedCount).toBe(0);
		expect(await settingsCommands(root)).toHaveLength(2);
	});

	it("does not touch a command that names two projects, in the copy form either", async () => {
		const root = await makeTree();
		const ambiguous = `${NODE} instructions check --project other --project project-1 --hook`;
		await mkdir(path.join(root, ".claude"), { recursive: true });
		await writeFile(
			path.join(root, ".claude", "settings.local.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: ambiguous }] },
					],
				},
			}),
		);

		const result = await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false, undefined, {}, NODE),
		});

		expect(result.replacedCount).toBe(0);
		expect(await settingsCommands(root)).toContain(ambiguous);
	});

	it("keeps the lesson hook of a project apart from its session hook, in the copy form", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand("project-1", false, undefined, {}, NODE),
		});
		await mergeCommandHook({
			root,
			projectId: "project-1",
			command: buildLessonPromptCommand("project-1", undefined, NODE),
			event: "Stop",
		});

		const removed = await removeCommandHook({
			root,
			projectId: "project-1",
			subcommand: "lesson-prompt",
			event: "Stop",
		});

		expect(removed.changed).toBe(true);
		expect(await settingsCommands(root)).toEqual([
			`${NODE} instructions check --project project-1 --hook`,
		]);
	});
});

describe("findSessionStartHooks", () => {
	it("returns a hook that runs a copy, with the path as written", async () => {
		const root = await makeTree();
		await mergeSessionStartHook({
			root,
			projectId: "project-1",
			command: buildHookCommand(
				"project-1",
				false,
				undefined,
				{},
				NODE_SPACED,
			),
		});

		const scan = await findSessionStartHooks({
			root,
			projectId: "project-1",
			tool: "claude-code",
		});

		expect(scan).toEqual({
			state: "ok",
			commands: [
				`${NODE_SPACED} instructions check --project project-1 --hook`,
			],
		});
	});
});
