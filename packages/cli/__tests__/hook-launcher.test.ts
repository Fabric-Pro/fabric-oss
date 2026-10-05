/**
 * What `init` makes a session hook run (`hook-launcher.ts`).
 *
 * The served build is one self-contained file, so `init` keeps a copy of it in
 * the CLI's config folder and the hook runs `node <copy>`: a person with only
 * the npx line has no `fabric` on PATH, and a hook that says `fabric` would
 * fail at every session start. The npm build cannot be copied and is started
 * as `fabric`, with one warning line when that is not on PATH.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	bundleCopyPath,
	resolveHookLauncher,
} from "../src/lib/instructions/hook-launcher.js";
import type { PathLookupEnvironment } from "../src/lib/instructions/path-lookup.js";

const ORIGIN = "http://localhost:3001";

let work: string;
let source: string;

beforeEach(async () => {
	work = await mkdtemp(path.join(tmpdir(), "fabric-hook-launcher-"));
	source = path.join(work, "downloaded", "fabric.js");
	await mkdir(path.dirname(source), { recursive: true });
	await writeFile(source, "#!/usr/bin/env node\nconsole.log('build one');\n");
});

function lookup(onPath: boolean): PathLookupEnvironment {
	return {
		env: { PATH: "/usr/bin" },
		platform: "linux",
		stat: async (candidate) => {
			if (onPath && candidate === "/usr/bin/fabric") {
				return { isFile: () => true, mode: 0o755 };
			}
			throw new Error("ENOENT");
		},
	};
}

function served(configDirectory: string) {
	return {
		origin: ORIGIN,
		configDirectory,
		lookup: lookup(false),
		bundle: { scriptPath: source },
	};
}

describe("the served build", () => {
	it("keeps a copy of itself and has the hook run it with `node`", async () => {
		const config = path.join(work, "config");

		const launcher = await resolveHookLauncher(served(config));

		const copy = bundleCopyPath(config, ORIGIN);
		expect(await readFile(copy, "utf8")).toBe(
			await readFile(source, "utf8"),
		);
		expect(launcher.prefix).toBe(`node ${copy.replace(/\\/g, "/")}`);
		expect(launcher.prefix.split(" ")[0]).toBe("node");
		expect(launcher.warning).toBeNull();
	});

	it("is an .mjs file, so node loads it as an ES module whatever package it sits in", async () => {
		const copy = bundleCopyPath(path.join(work, "config"), ORIGIN);

		expect(path.extname(copy)).toBe(".mjs");
	});

	it("keeps one copy per deployment", () => {
		const config = path.join(work, "config");

		expect(bundleCopyPath(config, "http://localhost:3001")).not.toBe(
			bundleCopyPath(config, "https://localhost:3001"),
		);
		expect(bundleCopyPath(config, "https://fabric.example.com")).not.toBe(
			bundleCopyPath(config, "https://staging.example.com"),
		);
		expect(
			path.basename(path.dirname(bundleCopyPath(config, ORIGIN))),
		).toBe("http-localhost-3001");
	});

	it("replaces the copy on the next init, so a newer build reaches a machine that has the hook", async () => {
		const config = path.join(work, "config");
		await resolveHookLauncher(served(config));
		await writeFile(source, "console.log('build two');\n");

		await resolveHookLauncher(served(config));

		expect(await readFile(bundleCopyPath(config, ORIGIN), "utf8")).toBe(
			"console.log('build two');\n",
		);
	});

	it("leaves no temporary file behind", async () => {
		const config = path.join(work, "config");

		await resolveHookLauncher(served(config));

		expect(
			await readdir(path.dirname(bundleCopyPath(config, ORIGIN))),
		).toEqual(["fabric.mjs"]);
	});

	it("does not copy a file onto itself when it already is the copy", async () => {
		const config = path.join(work, "config");
		const copy = bundleCopyPath(config, ORIGIN);
		await mkdir(path.dirname(copy), { recursive: true });
		await writeFile(copy, "already here\n");

		const launcher = await resolveHookLauncher({
			...served(config),
			bundle: { scriptPath: copy },
		});

		expect(await readFile(copy, "utf8")).toBe("already here\n");
		expect(launcher.prefix.startsWith("node ")).toBe(true);
	});

	it("quotes the path when the config folder has a space in it", async () => {
		const config = path.join(work, "Dev Config");

		const launcher = await resolveHookLauncher(served(config));

		const copy = bundleCopyPath(config, ORIGIN).replace(/\\/g, "/");
		expect(launcher.prefix).toBe(`node "${copy}"`);
	});

	it("refuses a config folder no shell reads the same way", async () => {
		const config = path.join(work, "dollar$sign");

		await expect(resolveHookLauncher(served(config))).rejects.toThrow(
			/cannot be written safely into a hook command/,
		);
		await expect(
			readdir(path.join(config, "cli")).catch(() => "absent"),
		).resolves.toBe("absent");
	});

	it("needs nothing on PATH", async () => {
		const launcher = await resolveHookLauncher({
			...served(path.join(work, "config")),
			lookup: lookup(false),
		});

		expect(launcher.warning).toBeNull();
	});
});

describe("the build npm publishes", () => {
	it("starts as `fabric`, and copies nothing", async () => {
		const config = path.join(work, "config");

		const launcher = await resolveHookLauncher({
			origin: ORIGIN,
			configDirectory: config,
			lookup: lookup(true),
			bundle: null,
		});

		expect(launcher).toEqual({ prefix: "fabric", warning: null });
		await expect(readdir(config).catch(() => "absent")).resolves.toBe(
			"absent",
		);
	});

	it("says once, in one line, that the hook cannot find `fabric` when it is not on PATH", async () => {
		const launcher = await resolveHookLauncher({
			origin: ORIGIN,
			configDirectory: path.join(work, "config"),
			lookup: lookup(false),
			bundle: null,
		});

		expect(launcher.prefix).toBe("fabric");
		expect(launcher.warning).toMatch(/not on this machine's PATH/);
		expect(launcher.warning).not.toContain("\n");
	});
});
