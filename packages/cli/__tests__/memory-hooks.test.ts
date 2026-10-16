import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";
import { desiredHooks, installPluginHooks } from "../src/lib/memory/hooks.js";

const PROJECT = "cmexampleproject0123456789";

let directory: string;
let root: string;

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "fabric-hooks-"));
	root = await resolveDestinationRoot(path.join(directory, "project"));
	await mkdir(root, { recursive: true });
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function hooksOf(file: string): Promise<Record<string, string[]>> {
	const parsed = JSON.parse(await readFile(path.join(root, file), "utf8"));
	return Object.fromEntries(
		Object.entries(
			parsed.hooks as Record<
				string,
				Array<{ hooks: Array<{ command: string }> }>
			>,
		).map(([event, groups]) => [
			event,
			groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
		]),
	);
}

describe("the hooks wanted", () => {
	it("are a pull at session start and a push at the end of a turn for Claude Code", () => {
		const wanted = desiredHooks({
			tool: "claude-code",
			projectId: PROJECT,
			launcher: "fabric",
			baseUrl: "https://example.com",
		});

		expect(
			wanted.map((hook) => [hook.event, hook.command, hook.timeout]),
		).toEqual([
			[
				"SessionStart",
				`fabric memory pull --project ${PROJECT} --base-url https://example.com --hook`,
				15,
			],
			[
				"Stop",
				`fabric memory push --project ${PROJECT} --base-url https://example.com --hook`,
				15,
			],
		]);
	});

	it("are a render and a flushing pull at session start for Codex, and no Stop hook", () => {
		const wanted = desiredHooks({
			tool: "codex",
			projectId: PROJECT,
			launcher: "fabric",
			org: "example-org",
		});

		expect(wanted.map((hook) => [hook.event, hook.command])).toEqual([
			[
				"SessionStart",
				`fabric instructions render --project ${PROJECT} --target codex --org example-org --hook`,
			],
			[
				"SessionStart",
				`fabric memory pull --project ${PROJECT} --flush --org example-org --hook`,
			],
		]);
	});

	it("refuse a project or organization that is not a plain identifier", () => {
		expect(() =>
			desiredHooks({
				tool: "claude-code",
				projectId: "a; rm -rf /",
				launcher: "fabric",
			}),
		).toThrow(/plain identifiers/);
		expect(() =>
			desiredHooks({
				tool: "claude-code",
				projectId: PROJECT,
				launcher: "fabric",
				org: "x y",
			}),
		).toThrow(/plain identifiers/);
	});
});

describe("installing them", () => {
	const install = (
		extra: Partial<Parameters<typeof installPluginHooks>[0]> = {},
	) =>
		installPluginHooks({
			root,
			tool: "claude-code",
			projectId: PROJECT,
			launcher: "fabric",
			baseUrl: "https://example.com",
			...extra,
		});

	it("writes them into .claude/settings.local.json", async () => {
		const result = await install();

		expect(result).toMatchObject({ createdFile: true, changed: true });
		expect(await hooksOf(".claude/settings.local.json")).toEqual({
			SessionStart: [
				`fabric memory pull --project ${PROJECT} --base-url https://example.com --hook`,
			],
			Stop: [
				`fabric memory push --project ${PROJECT} --base-url https://example.com --hook`,
			],
		});
	});

	it("replaces its own, in either launcher form, and never stacks", async () => {
		await install({ launcher: 'node "/home/dev/fabric/fabric.mjs"' });
		await install();
		await install();

		const hooks = await hooksOf(".claude/settings.local.json");
		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.SessionStart?.[0]).toMatch(/^fabric memory pull/);
	});

	it("leaves everyone else's hooks, another project's, and the rest of the file", async () => {
		const file = path.join(root, ".claude", "settings.local.json");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({
				permissions: { allow: ["Bash(ls)"] },
				hooks: {
					SessionStart: [
						{
							matcher: "startup",
							hooks: [{ type: "command", command: "echo mine" }],
						},
						{
							hooks: [
								{
									type: "command",
									command:
										"fabric memory pull --project another --hook",
								},
							],
						},
					],
					PreToolUse: [
						{ hooks: [{ type: "command", command: "echo guard" }] },
					],
				},
			}),
		);

		await install();

		const parsed = JSON.parse(await readFile(file, "utf8"));
		expect(parsed.permissions).toEqual({ allow: ["Bash(ls)"] });
		expect(parsed.hooks.PreToolUse).toHaveLength(1);
		expect(
			(await hooksOf(".claude/settings.local.json")).SessionStart,
		).toEqual([
			"echo mine",
			"fabric memory pull --project another --hook",
			`fabric memory pull --project ${PROJECT} --base-url https://example.com --hook`,
		]);
	});

	it("does not mistake a project whose id starts the same", async () => {
		await install({ projectId: `${PROJECT}-extra` });
		await install();

		expect(
			(await hooksOf(".claude/settings.local.json")).SessionStart,
		).toHaveLength(2);
	});

	it("is byte-for-byte the same file when run again", async () => {
		await install();
		const first = await readFile(
			path.join(root, ".claude", "settings.local.json"),
			"utf8",
		);

		const again = await install();

		expect(again.changed).toBe(false);
		expect(
			await readFile(
				path.join(root, ".claude", "settings.local.json"),
				"utf8",
			),
		).toBe(first);
	});

	it("writes Codex's file with the render and the flushing pull", async () => {
		await install({ tool: "codex" });

		const hooks = await hooksOf(".codex/hooks.json");
		expect(hooks.SessionStart).toHaveLength(2);
		expect(hooks.Stop).toBeUndefined();
	});

	it("refuses a hooks section of a shape it does not know, leaving the file alone", async () => {
		const file = path.join(root, ".claude", "settings.local.json");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ hooks: { SessionStart: "nope" } }),
		);

		await expect(install()).rejects.toThrow(/not an array/);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			hooks: { SessionStart: "nope" },
		});
	});
});
