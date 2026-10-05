/**
 * What `init` writes into the hook, end to end, for the two builds.
 *
 * The build a deployment serves is run with `npx`, so there is no `fabric` on
 * PATH: its hook has to run a copy of that build, with `node`. The build npm
 * publishes is started as `fabric`. The served build is simulated by defining
 * the globals the pack step defines; its own file is the source of the copy.
 */
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleScriptPath } from "../src/lib/launcher.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: () => undefined,
	hasStoredApiKey: () => mocks.getApiKey() !== undefined,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
		},
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

const TARBALL = "/cli/fabric-0.5.0-0123456789.tgz";

let config: string;

beforeEach(async () => {
	resetInstructionsMocks(mocks);
	config = await mkdtemp(path.join(tmpdir(), "fabric-config-"));
	mocks.getConfigPath.mockReturnValue(path.join(config, "config.json"));
	mocks.getPublished.mockResolvedValue({
		published: false,
		sourceOfTruth: "UPLOAD",
	});
	// Not under CI unless a test says so: CI runs these tests too.
	vi.stubEnv("CI", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function init(dest: string, ...extra: string[]) {
	return runCli([
		"init",
		"--project",
		"cm0example0project",
		"--tool",
		"claude-code",
		"--dest",
		dest,
		...extra,
	]);
}

async function hookCommands(dest: string): Promise<string[]> {
	const settings = JSON.parse(
		await readFile(
			path.join(dest, ".claude", "settings.local.json"),
			"utf8",
		),
	) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
	return settings.hooks.SessionStart.flatMap((group) =>
		group.hooks.map((hook) => hook.command),
	);
}

function serveFromBundle(): void {
	vi.stubGlobal("__FABRIC_BUNDLE__", true);
	vi.stubGlobal("__FABRIC_BUNDLE_TARBALL__", TARBALL);
	vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", undefined);
}

describe("init from the build a deployment serves", () => {
	it("writes a hook that runs a copy of that build with node, since there is no fabric", async () => {
		serveFromBundle();
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		const [command] = await hookCommands(dest);
		const copy = path.join(config, "cli", "https-fabric.pro", "fabric.mjs");
		expect(command).toBe(
			`node ${copy.replace(/\\/g, "/")} instructions check --project cm0example0project --base-url https://fabric.pro --hook`,
		);
		expect(command?.split(" ")[0]).toBe("node");
		expect(await readFile(copy, "utf8")).toBe(
			await readFile(bundleScriptPath(), "utf8"),
		);
	});

	it("says nothing about `fabric` being missing: the hook does not need it", async () => {
		serveFromBundle();
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.stdout).not.toContain("PATH");
		expect(result.stderr).toBe("");
	});

	it("replaces its own hook on a second run, leaving exactly one", async () => {
		serveFromBundle();
		const dest = await makeTree();
		await init(dest);

		const second = await init(dest, "--apply");

		expect(second.code).toBe(0);
		const commands = await hookCommands(dest);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("instructions sync --project");
		expect(
			await readdir(path.join(config, "cli", "https-fabric.pro")),
		).toEqual(["fabric.mjs"]);
	});

	it("replaces a hook an earlier version wrote in the `fabric` form", async () => {
		const dest = await makeTree();
		await init(dest);
		expect((await hookCommands(dest))[0]).toMatch(/^fabric instructions /);
		serveFromBundle();

		await init(dest);

		const commands = await hookCommands(dest);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatch(/^node .*fabric\.mjs instructions check /);
	});

	it("binds the hook and the copy to the deployment --base-url names", async () => {
		serveFromBundle();
		const dest = await makeTree();

		await init(dest, "--base-url", "http://localhost:3001");

		const [command] = await hookCommands(dest);
		expect(command).toContain("--base-url http://localhost:3001");
		expect(command).toContain("/cli/http-localhost-3001/fabric.mjs");
		expect(
			(
				await stat(
					path.join(
						config,
						"cli",
						"http-localhost-3001",
						"fabric.mjs",
					),
				)
			).isFile(),
		).toBe(true);
	});

	it("refuses before writing a hook when the config folder cannot be named safely in one", async () => {
		serveFromBundle();
		const dest = await makeTree();
		mocks.getConfigPath.mockReturnValue(
			path.join(config, "dollar$sign", "config.json"),
		);

		const result = await init(dest);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain(
			"cannot be written safely into a hook command",
		);
		await expect(
			readFile(path.join(dest, ".claude", "settings.local.json"), "utf8"),
		).rejects.toThrow();
	});
});

describe("what the served build tells someone to run", () => {
	it("is the npx line, so a person with no fabric can run it", async () => {
		serveFromBundle();
		vi.stubEnv("CI", "true");
		mocks.getApiKey.mockReturnValue(undefined);
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Not signed in to https://fabric.pro. Run: npx -y https://fabric.pro${TARBALL} auth login --base-url https://fabric.pro --project cm0example0project\n`,
		);
	});

	it("names the deployment --base-url chose, in the tarball's host and in the flag", async () => {
		serveFromBundle();
		vi.stubEnv("CI", "true");
		mocks.getApiKey.mockReturnValue(undefined);
		const dest = await makeTree();

		const result = await init(
			dest,
			"--base-url",
			"https://staging.example.com",
		);

		expect(result.stderr).toBe(
			`✗ Not signed in to https://staging.example.com. Run: npx -y https://staging.example.com${TARBALL} auth login --base-url https://staging.example.com --project cm0example0project\n`,
		);
	});

	it("names it too when a run has no project to work on", async () => {
		serveFromBundle();
		const dest = await makeTree();

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			`✗ This folder is not a git checkout, so its project cannot be found. Run: npx -y https://fabric.pro${TARBALL} instructions check --project <id>\n`,
		);
	});
});

describe("init from the build npm publishes", () => {
	it("writes the `fabric` hook and makes no copy", async () => {
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(await hookCommands(dest)).toEqual([
			"fabric instructions check --project cm0example0project --base-url https://fabric.pro --hook",
		]);
		await expect(readdir(path.join(config, "cli"))).rejects.toThrow();
	});

	it("says in one line that the hook cannot find `fabric` when it is not on PATH", async () => {
		const bare = await mkdtemp(path.join(tmpdir(), "fabric-bare-path-"));
		const original = process.env.PATH;
		process.env.PATH = bare;
		try {
			const dest = await makeTree();

			const result = await init(dest);

			expect(result.code).toBe(0);
			const warnings = result.stdout
				.split("\n")
				.filter((line) => line.includes("not on this machine's PATH"));
			expect(warnings).toHaveLength(1);
		} finally {
			process.env.PATH = original;
		}
	});
});
