/**
 * A developer's local overrides (`.fabric/local-overrides.json`): the file
 * itself, the `override` command that edits it, and `sync`, which never
 * writes or deletes an overridden path unless `--repair --include-overrides`
 * asks for exactly that. Push's share is in `push-command.test.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addOverride,
	NO_OVERRIDES,
	overrideMatcher,
	readLocalOverrides,
	removeOverride,
	writeLocalOverrides,
} from "../src/lib/instructions/local-overrides.js";
import { readLock } from "../src/lib/instructions/lock.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	sha256,
	snapshotFor,
	stubBundle,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		createFileDownloadUrls: vi.fn(),
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
	listProjectSignIns: () => [],
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
			createFileDownloadUrls: mocks.createFileDownloadUrls,
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

beforeEach(() => {
	resetInstructionsMocks(mocks);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function overrideIn(
	dest: string,
	overrides: { paths?: string[]; patterns?: string[] },
): Promise<void> {
	await mkdir(path.join(dest, ".fabric"), { recursive: true });
	await writeFile(
		path.join(dest, ".fabric", "local-overrides.json"),
		JSON.stringify({
			version: 1,
			paths: overrides.paths ?? [],
			patterns: overrides.patterns ?? [],
		}),
	);
}

describe("the overrides file", () => {
	it("reads as no overrides when the checkout has none", async () => {
		const dest = await makeTree();

		expect(await readLocalOverrides(dest)).toEqual(NO_OVERRIDES);
	});

	it("round-trips paths and patterns, sorted", async () => {
		const dest = await makeTree();

		await writeLocalOverrides(dest, {
			version: 1,
			paths: ["b.md", "a.md"],
			patterns: ["notes/**"],
		});

		expect(await readLocalOverrides(dest)).toEqual({
			version: 1,
			paths: ["a.md", "b.md"],
			patterns: ["notes/**"],
		});
	});

	it("refuses a file it cannot trust rather than reading it as empty", async () => {
		const dest = await makeTree();
		await mkdir(path.join(dest, ".fabric"), { recursive: true });
		await writeFile(
			path.join(dest, ".fabric", "local-overrides.json"),
			JSON.stringify({ version: 2, paths: [], patterns: [] }),
		);

		await expect(readLocalOverrides(dest)).rejects.toThrow(
			"local-overrides.json is unreadable",
		);
	});

	it("refuses a listed path this tool would never touch", async () => {
		const dest = await makeTree();
		await overrideIn(dest, { paths: ["../outside.md"] });

		await expect(readLocalOverrides(dest)).rejects.toThrow(
			"local-overrides.json is unreadable",
		);
	});
});

describe("addOverride and removeOverride", () => {
	it("adds a path once and a pattern by its glob characters", () => {
		const first = addOverride(NO_OVERRIDES, "CLAUDE.md");
		const again = addOverride(first.overrides, "CLAUDE.md");
		const pattern = addOverride(again.overrides, "notes/**");

		expect(first.changed).toBe(true);
		expect(again.changed).toBe(false);
		expect(pattern.overrides).toEqual({
			version: 1,
			paths: ["CLAUDE.md"],
			patterns: ["notes/**"],
		});
	});

	it("refuses a traversal, a reserved path and a case-only twin", () => {
		const listed = addOverride(NO_OVERRIDES, "CLAUDE.md").overrides;

		expect(() => addOverride(NO_OVERRIDES, "../x.md")).toThrow(
			"Cannot override",
		);
		expect(() =>
			addOverride(NO_OVERRIDES, ".fabric/instructions.lock"),
		).toThrow("Cannot override");
		expect(() => addOverride(listed, "claude.md")).toThrow(
			"case-insensitive",
		);
		expect(() => addOverride(NO_OVERRIDES, "!notes/*")).toThrow(
			"Cannot override",
		);
	});

	it("removes an entry exactly as it was added", () => {
		const listed = addOverride(
			addOverride(NO_OVERRIDES, "CLAUDE.md").overrides,
			"notes/**",
		).overrides;

		const removed = removeOverride(listed, "notes/**");
		const missing = removeOverride(removed.overrides, "other.md");

		expect(removed.changed).toBe(true);
		expect(removed.overrides.patterns).toEqual([]);
		expect(missing.changed).toBe(false);
	});
});

describe("overrideMatcher", () => {
	it("matches a path under any case spelling and a pattern's files", () => {
		const isOverridden = overrideMatcher({
			version: 1,
			paths: ["CLAUDE.md"],
			patterns: ["notes/**"],
		});

		expect(isOverridden("CLAUDE.md")).toBe(true);
		expect(isOverridden("claude.md")).toBe(true);
		expect(isOverridden("notes/today.md")).toBe(true);
		expect(isOverridden("AGENTS.md")).toBe(false);
	});

	it("matches nothing when there are no overrides", () => {
		expect(overrideMatcher(NO_OVERRIDES)("AGENTS.md")).toBe(false);
	});
});

describe("fabric instructions override", () => {
	it("adds, lists and removes an entry in the checkout's file", async () => {
		const dest = await makeTree();

		const added = await runCli([
			"override",
			"add",
			"CLAUDE.md",
			"--dest",
			dest,
		]);
		const listed = await runCli([
			"override",
			"list",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(added.code).toBe(0);
		expect(added.stdout).toContain("CLAUDE.md is now a local override");
		expect(JSON.parse(listed.stdout)).toEqual({
			paths: ["CLAUDE.md"],
			patterns: [],
		});

		const removed = await runCli([
			"override",
			"remove",
			"CLAUDE.md",
			"--dest",
			dest,
		]);

		expect(removed.code).toBe(0);
		expect(removed.stdout).toContain("no longer a local override");
		expect(await readLocalOverrides(dest)).toEqual(NO_OVERRIDES);
	});

	it("refuses a path it would never touch with exit 2 and writes nothing", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"override",
			"add",
			".fabric/instructions.lock",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("Cannot override");
		expect(await readLocalOverrides(dest)).toEqual(NO_OVERRIDES);
	});
});

describe("sync with local overrides", () => {
	async function editedUnderOverride(): Promise<string> {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "my own edit");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("previous"), mode: 0o100644 },
		});
		await overrideIn(dest, { paths: ["AGENTS.md"] });
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});
		return dest;
	}

	it("never overwrites an override and says the published file changed under it", async () => {
		const dest = await editedUnderOverride();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"my own edit",
		);
		expect(result.stdout).toContain("local override:");
		expect(result.stdout).toContain(
			"published changed under your override:",
		);
		expect(result.stdout).not.toContain("kept local edits:");
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		const lock = await readLock(dest);
		expect(lock?.snapshotVersion).toBe(8);
		expect(lock?.files["AGENTS.md"]).toEqual({
			sha256: sha256("published\n"),
			mode: 0o100644,
			kept: true,
		});
	});

	it("leaves an override alone under --repair", async () => {
		const dest = await editedUnderOverride();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--repair",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"my own edit",
		);
		expect(result.stdout).not.toContain("replaced local edits:");
		expect(result.stdout).toContain("local override:");
	});

	it("replaces an override under --repair --include-overrides", async () => {
		const dest = await editedUnderOverride();
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: "d".repeat(64),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "published\n" });

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--repair",
			"--include-overrides",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		expect(result.stdout).toContain("replaced local edits:");
	});

	it("refuses --include-overrides without --repair", async () => {
		const dest = await editedUnderOverride();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--include-overrides",
		]);

		expect(result.code).toBe(2);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"my own edit",
		);
	});

	it("keeps an overridden file the published version no longer has", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "hello\n");
		await mkdir(path.join(dest, "notes"), { recursive: true });
		await writeFile(path.join(dest, "notes", "old.md"), "old\n");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("hello\n"), mode: 0o100644 },
			"notes/old.md": { sha256: sha256("old\n"), mode: 0o100644 },
		});
		await overrideIn(dest, { patterns: ["notes/**"] });
		const manifest = [manifestEntry("AGENTS.md", "hello\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "notes", "old.md"), "utf8")).toBe(
			"old\n",
		);
		expect(result.stdout).toContain("local override:");
		expect(result.stdout).toContain("    notes/old.md");
		const lock = await readLock(dest);
		expect(lock?.files["notes/old.md"]).toBeUndefined();
	});

	it("refuses to sync with an unreadable overrides file, touching nothing", async () => {
		const dest = await editedUnderOverride();
		await writeFile(
			path.join(dest, ".fabric", "local-overrides.json"),
			"{ not json",
		);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).not.toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"my own edit",
		);
		expect((await readLock(dest))?.snapshotVersion).toBe(6);
	});
});
