/**
 * The hidden `instructions self-update` command the hook starts in a detached
 * child when it had no time left for the daily update. It must make the
 * attempt itself (its own budget, no `no-time`) and must never start another
 * child, or every run would spawn a chain of processes that never download.
 * Everything real except the network (a stubbed fetch) and `spawn` (counted).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCopyPath } from "../src/lib/instructions/hook-launcher.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
} from "./helpers/instructions-commands.js";

const ORIGIN = "https://fabric.example.com";
const TARBALL = "/cli/fabric-0.5.0-0123456789.tgz";

const { mocks, paths } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<(origin?: string) => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
		spawn: vi.fn(),
	},
	paths: { script: "" },
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
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
		withoutContext: () => client,
	};
	return { getClient: () => client };
});

vi.mock("../src/lib/launcher.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/launcher.js")>()),
	bundleScriptPath: () => paths.script,
	bundleTarballPath: () => TARBALL,
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: mocks.spawn,
}));

let config: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	resetInstructionsMocks(mocks);
	mocks.spawn.mockReset();
	config = await makeTree();
	mocks.getConfigPath.mockReturnValue(path.join(config, "config.json"));
	paths.script = bundleCopyPath(config, ORIGIN);
	await mkdir(path.dirname(paths.script), { recursive: true });
	await writeFile(paths.script, "#!/usr/bin/env node\n");
	vi.stubEnv("CI", "");
	vi.stubEnv("FABRIC_CLI_NO_SELF_UPDATE", "");
	fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					spec: 1,
					tarball: TARBALL,
					integrity: `sha512-${"A".repeat(86)}==`,
				}),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("instructions self-update, run as the hook's detached child", () => {
	it("asks the deployment itself and starts no further child", async () => {
		const result = await runCli(["self-update", "--base-url", ORIGIN]);

		expect(result.code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			`${ORIGIN}/.well-known/fabric-cli.json`,
		);
		expect(mocks.spawn).not.toHaveBeenCalled();
		const state = JSON.parse(
			await readFile(
				path.join(path.dirname(paths.script), "update-check.json"),
				"utf8",
			),
		);
		expect(state.tarball).toBe(TARBALL);
	});

	it("starts nothing when it asked recently, and does not ask again", async () => {
		await runCli(["self-update", "--base-url", ORIGIN]);
		fetchMock.mockClear();

		await runCli(["self-update", "--base-url", ORIGIN]);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
