import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../src/lib/instructions/agent-run.js";
import {
	codexPluginReference,
	installCodexPlugin,
	refreshCodexInstall,
} from "../src/lib/plugin/codex-install.js";

const PROJECT = "cmexampleproject0123456789";
const VERSION = "0.0.0-abc123def456";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(path.join(tmpdir(), "fabric-codex-install-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function list(marketplaceName: string, plugins: string[]) {
	const file = path.join(home, ".agents", "plugins", "marketplace.json");
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(
		file,
		JSON.stringify({
			name: marketplaceName,
			plugins: plugins.map((name) => ({
				name,
				source: { source: "local", path: `./${name}` },
			})),
		}),
	);
}

const exited = (code: number): AgentRun => ({
	kind: "exited",
	code,
	stdout: "",
	stderr: "",
});

describe("installCodexPlugin", () => {
	it("runs codex plugin add with the plugin and marketplace names", async () => {
		const run = vi.fn().mockResolvedValue(exited(0));

		const result = await installCodexPlugin({
			run,
			projectId: PROJECT,
			marketplaceName: "mine",
			cwd: "/work",
		});

		expect(result).toEqual({ kind: "installed" });
		expect(run).toHaveBeenCalledWith(
			"codex",
			["plugin", "add", "fabric-23456789@mine"],
			{ cwd: "/work", timeoutMs: 120_000 },
		);
	});

	it.each([
		["a failing exit", exited(1)],
		["a missing codex", { kind: "missing" } as const],
		["a timeout", { kind: "timed-out" } as const],
	])("gives the command to run after %s", async (_name, outcome) => {
		const result = await installCodexPlugin({
			run: vi.fn().mockResolvedValue(outcome),
			projectId: PROJECT,
			marketplaceName: "mine",
			cwd: "/work",
		});

		expect(result).toEqual({
			kind: "manual",
			line: "codex plugin add fabric-23456789@mine",
		});
	});

	it("gives no line for a marketplace name that cannot be written into a command", async () => {
		const result = await installCodexPlugin({
			run: vi.fn().mockResolvedValue({ kind: "refused" }),
			projectId: PROJECT,
			marketplaceName: "my market",
			cwd: "/work",
		});

		expect(result).toEqual({ kind: "manual", line: null });
	});
});

describe("refreshCodexInstall", () => {
	it("re-adds the plugin from the marketplace that lists it, within a bounded time", async () => {
		await list("mine", ["other", "fabric-23456789"]);
		const run = vi.fn().mockResolvedValue(exited(0));

		await refreshCodexInstall({
			run,
			home,
			codexHome: path.join(home, ".codex"),
			projectId: PROJECT,
			version: VERSION,
			cwd: "/work",
		});

		expect(run).toHaveBeenCalledTimes(1);
		const [command, args, options] = run.mock.calls[0] ?? [];
		expect(command).toBe("codex");
		expect(args).toEqual([
			"plugin",
			"add",
			codexPluginReference(PROJECT, "mine"),
		]);
		expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
	});

	it("does nothing when no marketplace lists the plugin", async () => {
		await list("mine", ["other"]);
		const run = vi.fn();

		await refreshCodexInstall({
			run,
			home,
			codexHome: path.join(home, ".codex"),
			projectId: PROJECT,
			version: VERSION,
			cwd: "/work",
		});

		expect(run).not.toHaveBeenCalled();
	});

	it("does nothing when there is no marketplace file", async () => {
		const run = vi.fn();

		await refreshCodexInstall({
			run,
			home,
			codexHome: path.join(home, ".codex"),
			projectId: PROJECT,
			version: VERSION,
			cwd: "/work",
		});

		expect(run).not.toHaveBeenCalled();
	});

	it("swallows a runner that throws", async () => {
		await list("mine", ["fabric-23456789"]);
		const run = vi.fn().mockRejectedValue(new Error("spawn failed"));

		await expect(
			refreshCodexInstall({
				run,
				home,
				codexHome: path.join(home, ".codex"),
				projectId: PROJECT,
				version: VERSION,
				cwd: "/work",
			}),
		).resolves.toBeUndefined();
	});

	it("does nothing when Codex already holds this version", async () => {
		await list("mine", ["fabric-23456789"]);
		await mkdir(
			path.join(
				home,
				".codex",
				"plugins",
				"cache",
				"mine",
				"fabric-23456789",
				VERSION,
			),
			{ recursive: true },
		);
		const run = vi.fn();

		await refreshCodexInstall({
			run,
			home,
			codexHome: path.join(home, ".codex"),
			projectId: PROJECT,
			version: VERSION,
			cwd: "/work",
		});

		expect(run).not.toHaveBeenCalled();
	});

	it("re-adds when Codex holds only an older version, so a refresh that failed once is retried", async () => {
		await list("mine", ["fabric-23456789"]);
		await mkdir(
			path.join(
				home,
				".codex",
				"plugins",
				"cache",
				"mine",
				"fabric-23456789",
				"0.0.0-olderpin000",
			),
			{ recursive: true },
		);
		const run = vi.fn().mockResolvedValue(exited(0));

		await refreshCodexInstall({
			run,
			home,
			codexHome: path.join(home, ".codex"),
			projectId: PROJECT,
			version: VERSION,
			cwd: "/work",
		});

		expect(run).toHaveBeenCalledTimes(1);
	});
});
