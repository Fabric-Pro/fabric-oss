/**
 * A deployment's own tarball learns its origin when it is packed (Fizzy #2878):
 * the bundle build defines `__FABRIC_BAKED_ORIGIN__`, the npm build leaves it
 * out. The origin sits between the environment and the active profile, so
 * `--base-url` > `FABRIC_BASE_URL` > baked origin > profile > default, and
 * the hook `init` writes is bound to whichever of them won.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { getBaseUrl, saveApiKey } from "../src/lib/config.js";
import { bakedOrigin } from "../src/lib/origin.js";
import { makeTree, runCli } from "./helpers/instructions-commands.js";

const BAKED = "https://deploy.example.com";
const ELSEWHERE = "https://elsewhere.example.com";

let requestedUrls: string[];

beforeAll(async () => {
	const home = await mkdtemp(path.join(tmpdir(), "fabric-baked-"));
	process.env.XDG_CONFIG_HOME = home;
	process.env.APPDATA = home;
});

beforeEach(() => {
	requestedUrls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			requestedUrls.push(String(input));
			return new Response(
				JSON.stringify({
					data: { published: false, sourceOfTruth: "UPLOAD" },
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}),
	);
	process.env.FABRIC_API_KEY = "fab_test";
	delete process.env.FABRIC_BASE_URL;
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.FABRIC_API_KEY;
	delete process.env.FABRIC_BASE_URL;
});

describe("bakedOrigin", () => {
	it("is undefined when the build defines nothing, so the identifier may not exist", () => {
		const origin = bakedOrigin();

		expect(origin).toBeUndefined();
	});

	it("is undefined when the build defines it as undefined", () => {
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", undefined);

		const origin = bakedOrigin();

		expect(origin).toBeUndefined();
	});

	it("is the origin of what the build defines, and nothing more", () => {
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", `${BAKED}/some/path?x=1`);

		const origin = bakedOrigin();

		expect(origin).toBe(BAKED);
	});

	it.each([
		["an empty string", ""],
		["something that is not a URL", "deploy"],
		["a scheme that is not http", "ftp://deploy.example.com"],
	])("is undefined for %s", (_label, defined) => {
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", defined);

		const origin = bakedOrigin();

		expect(origin).toBeUndefined();
	});
});

describe("the base URL a command resolves", () => {
	it("is the baked origin when nothing else names one", () => {
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", BAKED);

		const resolved = getBaseUrl();

		expect(resolved).toBe(BAKED);
	});

	it("lets FABRIC_BASE_URL win over the baked origin", () => {
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", BAKED);
		process.env.FABRIC_BASE_URL = ELSEWHERE;

		const resolved = getBaseUrl();

		expect(resolved).toBe(ELSEWHERE);
	});

	it("lets the baked origin win over the active profile's deployment", () => {
		saveApiKey("fab_profile_key", { baseUrl: ELSEWHERE });
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", BAKED);

		const resolved = getBaseUrl();

		expect(resolved).toBe(BAKED);
	});

	it("falls back to the active profile's deployment on a build with no baked origin", () => {
		saveApiKey("fab_profile_key", { baseUrl: ELSEWHERE });

		const resolved = getBaseUrl();

		expect(resolved).toBe(ELSEWHERE);
	});
});

describe("the hook init writes", () => {
	async function hookCommand(dest: string): Promise<string> {
		const hooks = JSON.parse(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		);
		return hooks.hooks.SessionStart[0].hooks[0].command;
	}

	it("carries the baked origin, and talks to it", async () => {
		const dest = await makeTree();
		saveApiKey("fab_profile_key", { baseUrl: ELSEWHERE });
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", BAKED);

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await hookCommand(dest)).toBe(
			`fabric instructions check --project project-1 --base-url ${BAKED} --hook`,
		);
		expect(requestedUrls.length).toBeGreaterThan(0);
		for (const url of requestedUrls) {
			expect(url.startsWith(`${BAKED}/`)).toBe(true);
		}
	});

	it("carries --base-url over the baked origin", async () => {
		const dest = await makeTree();
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", BAKED);

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--base-url",
			ELSEWHERE,
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await hookCommand(dest)).toBe(
			`fabric instructions check --project project-1 --base-url ${ELSEWHERE} --hook`,
		);
	});

	it("carries FABRIC_BASE_URL over the baked origin", async () => {
		const dest = await makeTree();
		vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", BAKED);
		process.env.FABRIC_BASE_URL = ELSEWHERE;

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await hookCommand(dest)).toBe(
			`fabric instructions check --project project-1 --base-url ${ELSEWHERE} --hook`,
		);
	});
});

describe("a deployment address that is not a URL", () => {
	const LINE =
		"The deployment address is not a URL. Use --base-url https://example.com";

	it.each([
		["http://"],
		["deploy.example.com"],
		["ftp://deploy.example.com"],
	])(
		"in FABRIC_BASE_URL (%s) stops the command and sends no request",
		async (address) => {
			const dest = await makeTree();
			process.env.FABRIC_BASE_URL = address;

			const result = await runCli([
				"check",
				"--project",
				"project-1",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(2);
			expect(result.stderr).toBe(`✗ ${LINE}\n`);
			expect(requestedUrls).toEqual([]);
		},
	);

	it("is never the default deployment under another name: init writes no hook", async () => {
		const dest = await makeTree();
		process.env.FABRIC_BASE_URL = "http://";

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(requestedUrls).toEqual([]);
		await expect(
			readFile(path.join(dest, ".claude", "settings.local.json"), "utf8"),
		).rejects.toThrow();
	});

	it("is a skip, not a failure, from a hook", async () => {
		const dest = await makeTree();
		process.env.FABRIC_BASE_URL = "http://";

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			`fabric: coding instructions check skipped: ${LINE}\n`,
		);
		expect(requestedUrls).toEqual([]);
	});
});
